[CmdletBinding()]
param(
    [switch]$PlanOnly,
    [switch]$SelfTest,
    [string]$RemoteHost = 'jarvis',
    [string]$RemoteCommand = 'git-monitor-release'
)

# Interface remota padrao: git-monitor-release --apply <package.tgz>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail {
    param([string]$Message)
    throw "[git-monitor-push] $Message"
}

function Run {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    Write-Host ">> $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        Fail "Comando falhou com exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
}

function Capture {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    $output = & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        Fail "Comando falhou com exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
    return ($output -join "`n").Trim()
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Fail "Comando obrigatorio nao encontrado no PATH: $Name"
    }
}

function Normalize-RepoPath {
    param([string]$Path)
    return ($Path -replace '\\', '/').Trim('"')
}

function ConvertTo-JsonArrayLiteral {
    param([string[]]$Values)

    $items = @($Values | ForEach-Object {
        '"' + ($_ -replace '\\', '\\' -replace '"', '\"') + '"'
    })
    return '[' + ($items -join ',') + ']'
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Write-GitDiffPatch {
    param([string]$Path)

    $errorPath = [System.IO.Path]::GetTempFileName()
    try {
        $args = @(
            'diff',
            '--binary',
            'HEAD',
            '--',
            '.',
            ':!dist/**',
            ':!node_modules/**',
            ':!.secrets/**'
        )
        $process = Start-Process -FilePath 'git' `
            -ArgumentList $args `
            -NoNewWindow `
            -Wait `
            -PassThru `
            -RedirectStandardOutput $Path `
            -RedirectStandardError $errorPath

        if ($process.ExitCode -ne 0) {
            $stderr = ''
            if (Test-Path -LiteralPath $errorPath) {
                $stderr = Get-Content -LiteralPath $errorPath -Raw -ErrorAction SilentlyContinue
            }
            Fail "Nao foi possivel gerar patch git: $stderr"
        }
    }
    finally {
        Remove-Item -LiteralPath $errorPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-ChangedEntries {
    $lines = & git status --porcelain=v1
    if ($LASTEXITCODE -ne 0) {
        Fail "Nao foi possivel ler git status"
    }

    $entries = @()
    foreach ($line in $lines) {
        if ($line.Length -lt 4) {
            continue
        }

        $status = $line.Substring(0, 2)
        $path = $line.Substring(3)
        if ($path -match ' -> ') {
            $path = ($path -split ' -> ')[-1]
        }

        $entries += [pscustomobject]@{
            Status = $status
            Path = Normalize-RepoPath $path
        }
    }

    return $entries
}

function Test-IgnoredReleasePath {
    param([string]$Path)
    return $Path -match '^dist(/|$)'
}

function Test-BlockedReleasePath {
    param([string]$Path)

    $blockedPatterns = @(
        '^\.secrets(/|$)',
        '^node_modules(/|$)',
        '^assets(/|$)',
        '^config\.json$',
        '(^|/)nul(/|$)',
        '(^|/)[^/]+\.(db|sqlite|sqlite3|db-journal|sqlite-journal)$'
    )

    foreach ($pattern in $blockedPatterns) {
        if ($Path -match $pattern) {
            return $true
        }
    }

    $mediaExtensions = '\.(jpg|jpeg|png|webp|gif|avif|bmp|tiff|tif|mp4|mov|avi|mkv|webm|wmv|flv|m4v)$'
    $mediaAllowList = @(
        '^docs/',
        '^public/',
        '^\.codex/skills/push/'
    )

    if ($Path -match $mediaExtensions) {
        foreach ($allow in $mediaAllowList) {
            if ($Path -match $allow) {
                return $false
            }
        }
        return $true
    }

    return $false
}

function Split-ReleasePaths {
    param([object[]]$Entries)

    $safe = New-Object System.Collections.Generic.List[string]
    $ignored = New-Object System.Collections.Generic.List[string]
    $blocked = New-Object System.Collections.Generic.List[string]

    foreach ($entry in $Entries) {
        if (Test-IgnoredReleasePath $entry.Path) {
            $ignored.Add($entry.Path)
        }
        elseif (Test-BlockedReleasePath $entry.Path) {
            $blocked.Add($entry.Path)
        }
        else {
            $safe.Add($entry.Path)
        }
    }

    return [pscustomobject]@{
        Safe = @($safe | Sort-Object -Unique)
        Ignored = @($ignored | Sort-Object -Unique)
        Blocked = @($blocked | Sort-Object -Unique)
    }
}

function Assert-NoBlockedReleasePaths {
    param([string[]]$Paths)

    if ($Paths.Count -gt 0) {
        Fail "Arquivos bloqueados no worktree/stage. Remova ou confirme manualmente fora do /push:`n$($Paths -join "`n")"
    }
}

function Get-NextPatchVersion {
    param([string]$CurrentVersion)

    if ($CurrentVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
        Fail "Versao atual precisa ser SemVer simples X.Y.Z para patch automatico. Recebido: $CurrentVersion"
    }

    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3] + 1
    return "$major.$minor.$patch"
}

function Get-GitSyncStatus {
    param(
        [int]$Ahead,
        [int]$Behind
    )

    if ($Behind -eq 0) {
        return 'ok'
    }

    if ($Ahead -eq 0) {
        return 'behind'
    }

    return 'diverged'
}

function Assert-GitMonitorRepo {
    $repoRoot = Capture 'git' @('rev-parse', '--show-toplevel')
    $cwd = (Resolve-Path -LiteralPath '.').Path
    $resolvedRoot = (Resolve-Path -LiteralPath $repoRoot).Path
    $expectedRoot = (Resolve-Path -LiteralPath 'C:\Users\ronyo\projects\git-monitor').Path

    if ($cwd -ne $resolvedRoot) {
        Fail "Execute /push na raiz do repo. cwd=$cwd repo=$resolvedRoot"
    }

    if ($resolvedRoot -ne $expectedRoot) {
        Fail "Esta skill so pode rodar em $expectedRoot. Repo atual: $resolvedRoot"
    }

    $package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
    if ($package.name -ne 'git-monitor') {
        Fail "package.json nao parece ser do Git Monitor"
    }

    if ($package.build.productName -ne 'Git Monitor') {
        Fail "build.productName inesperado em package.json: $($package.build.productName)"
    }
}

function Assert-GitPreflight {
    $branch = Capture 'git' @('rev-parse', '--abbrev-ref', 'HEAD')
    if ($branch -ne 'master') {
        Fail "Branch atual precisa ser master. Atual: $branch"
    }

    $origin = Capture 'git' @('remote', 'get-url', 'origin')
    if ($origin -notmatch 'github\.com[:/]+ronydrop/git-monitor(\.git)?$') {
        Fail "Remote origin inesperado: $origin"
    }

    Run 'git' @('fetch', 'origin', '+refs/heads/master:refs/remotes/origin/master', '--tags')

    $aheadBehind = Capture 'git' @('rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/master')
    $parts = $aheadBehind -split '\s+'
    if ($parts.Count -ne 2) {
        Fail "Nao foi possivel comparar master com origin/master. Saida: $aheadBehind"
    }

    $ahead = [int]$parts[0]
    $behind = [int]$parts[1]
    $syncStatus = Get-GitSyncStatus -Ahead $ahead -Behind $behind

    if ($syncStatus -eq 'behind') {
        Fail "origin/master esta $behind commit(s) a frente. Atualize com git pull --rebase origin master antes de rodar /push."
    }

    if ($syncStatus -eq 'diverged') {
        Fail "master divergiu de origin/master (local +$ahead, remoto +$behind). Resolva manualmente com rebase/merge antes de rodar /push."
    }

    if ($ahead -gt 0) {
        Write-Host "master local esta $ahead commit(s) a frente de origin/master."
    }
}

function Assert-ReleasePreflight {
    foreach ($command in @('git', 'node', 'npm', 'ssh', 'scp', 'tar')) {
        Assert-Command $command
    }
}

function Assert-TagAvailable {
    param([string]$Version)

    $tagName = "v$Version"
    $localTag = & git rev-parse -q --verify "refs/tags/$tagName"
    if ($LASTEXITCODE -eq 0 -and $localTag) {
        Fail "Tag local ja existe: $tagName"
    }

    $remoteTag = & git ls-remote --exit-code --tags origin "refs/tags/$tagName" 2>$null
    if ($LASTEXITCODE -eq 0 -and $remoteTag) {
        Fail "Tag remota ja existe: $tagName"
    }

    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 2) {
        Fail "Nao foi possivel consultar tag remota: $tagName"
    }
}

function New-ReleasePackage {
    param(
        [string[]]$SafePaths,
        [string[]]$IgnoredPaths,
        [string]$NextVersion
    )

    if ($SafePaths.Count -eq 0) {
        Fail "Nenhuma mudanca segura para enviar ao Jarvis"
    }

    $baseHead = Capture 'git' @('rev-parse', 'HEAD')
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "git-monitor-release-$stamp-$PID"
    $payloadDir = Join-Path $tempRoot 'payload'
    $untrackedDir = Join-Path $payloadDir 'untracked'
    New-Item -ItemType Directory -Force -Path $payloadDir, $untrackedDir | Out-Null

    try {
        $patchPath = Join-Path $payloadDir 'changes.patch'
        Write-GitDiffPatch -Path $patchPath

        $untrackedRaw = & git ls-files --others --exclude-standard
        if ($LASTEXITCODE -ne 0) {
            Fail "Nao foi possivel listar arquivos untracked"
        }

        $untrackedSafe = @()
        foreach ($path in $untrackedRaw) {
            $normalized = Normalize-RepoPath $path
            if ($SafePaths -contains $normalized) {
                $untrackedSafe += $normalized
                $target = Join-Path $untrackedDir ($normalized -replace '/', [System.IO.Path]::DirectorySeparatorChar)
                $targetDir = Split-Path -Parent $target
                New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
                Copy-Item -LiteralPath $normalized -Destination $target -Force
            }
        }

        $trackedSafe = @($SafePaths | Where-Object { $untrackedSafe -notcontains $_ })
        $manifest = @"
{
  "createdAt": "$(Get-Date -Format o)",
  "baseHead": "$baseHead",
  "nextVersion": "$NextVersion",
  "trackedPaths": $(ConvertTo-JsonArrayLiteral $trackedSafe),
  "untrackedPaths": $(ConvertTo-JsonArrayLiteral $untrackedSafe),
  "ignoredPaths": $(ConvertTo-JsonArrayLiteral $IgnoredPaths)
}
"@
        Write-Utf8NoBom -Path (Join-Path $payloadDir 'manifest.json') -Content $manifest

        $packagePath = Join-Path $tempRoot "git-monitor-$stamp.tgz"
        Run 'tar' @('-czf', $packagePath, '-C', $payloadDir, '.')
        return [pscustomobject]@{
            Path = $packagePath
            TempRoot = $tempRoot
        }
    }
    catch {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Invoke-SelfTest {
    $next = Get-NextPatchVersion '1.2.42'
    if ($next -ne '1.2.43') {
        Fail "SelfTest falhou: patch esperado 1.2.43, recebido $next"
    }

    $syncCases = @(
        @{ Ahead = 0; Behind = 0; Expected = 'ok' },
        @{ Ahead = 2; Behind = 0; Expected = 'ok' },
        @{ Ahead = 0; Behind = 1; Expected = 'behind' },
        @{ Ahead = 2; Behind = 1; Expected = 'diverged' }
    )

    foreach ($case in $syncCases) {
        $actual = Get-GitSyncStatus -Ahead $case.Ahead -Behind $case.Behind
        if ($actual -ne $case.Expected) {
            Fail "SelfTest falhou: sync esperado $($case.Expected), recebido $actual"
        }
    }

    $paths = Split-ReleasePaths @(
        [pscustomobject]@{ Status = ' M'; Path = 'main.js' },
        [pscustomobject]@{ Status = ' M'; Path = 'dist/GitMonitor-portable.exe' },
        [pscustomobject]@{ Status = '??'; Path = '.secrets/token.txt' }
    )

    if ($paths.Safe -notcontains 'main.js') {
        Fail 'SelfTest falhou: main.js deveria ser seguro'
    }
    if ($paths.Ignored -notcontains 'dist/GitMonitor-portable.exe') {
        Fail 'SelfTest falhou: dist deveria ser ignorado'
    }
    if ($paths.Blocked -notcontains '.secrets/token.txt') {
        Fail 'SelfTest falhou: .secrets deveria ser bloqueado'
    }

    Write-Host 'SelfTest OK'
}

if ($SelfTest) {
    Invoke-SelfTest
    exit 0
}

Write-Step 'Preflight local'
Assert-GitMonitorRepo
Assert-GitPreflight
Assert-ReleasePreflight

$entries = Get-ChangedEntries
$paths = Split-ReleasePaths $entries
Assert-NoBlockedReleasePaths $paths.Blocked

$packageJson = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$currentVersion = [string]$packageJson.version
$nextVersion = Get-NextPatchVersion $currentVersion
Assert-TagAvailable $nextVersion

Write-Host "Versao atual: $currentVersion"
Write-Host "Proxima versao patch: $nextVersion"
Write-Host "Mudancas seguras: $($paths.Safe.Count)"
if ($paths.Ignored.Count -gt 0) {
    Write-Host "Mudancas ignoradas no pacote:" -ForegroundColor Yellow
    $paths.Ignored | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}

Write-Step 'Preflight remoto'
Run 'ssh' @($RemoteHost, "$RemoteCommand --plan-only")

if ($PlanOnly) {
    Write-Host "PlanOnly ativo: nenhum pacote sera enviado e nenhum release sera criado."
    exit 0
}

Write-Step 'Empacotar mudancas seguras'
$releasePackage = $null
$releasePackage = New-ReleasePackage -SafePaths $paths.Safe -IgnoredPaths $paths.Ignored -NextVersion $nextVersion

try {
    $remotePackage = "/srv/git-monitor/incoming/git-monitor-local-$([System.IO.Path]::GetFileName($releasePackage.Path))"
    Write-Step 'Enviar pacote para Jarvis'
    Run 'ssh' @($RemoteHost, 'mkdir -p /srv/git-monitor/incoming')
    Run 'scp' @('-O', $releasePackage.Path, "${RemoteHost}:$remotePackage")

    Write-Step 'Executar release remoto'
    Run 'ssh' @($RemoteHost, "$RemoteCommand --apply '$remotePackage'")
}
finally {
    if ($releasePackage -and (Test-Path -LiteralPath $releasePackage.TempRoot)) {
        Remove-Item -LiteralPath $releasePackage.TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
