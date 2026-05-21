[CmdletBinding()]
param(
    [switch]$PlanOnly,
    [switch]$SelfTest
)

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

function Get-ChangedPaths {
    $lines = & git status --porcelain=v1
    if ($LASTEXITCODE -ne 0) {
        Fail "Nao foi possivel ler git status"
    }

    $paths = @()
    foreach ($line in $lines) {
        if ($line.Length -lt 4) {
            continue
        }

        $path = $line.Substring(3)
        if ($path -match ' -> ') {
            $path = ($path -split ' -> ')[-1]
        }

        $paths += (Normalize-RepoPath $path)
    }

    return $paths
}

function Assert-NoDangerousChangedPaths {
    param([string[]]$Paths)

    $dangerousPatterns = @(
        '^\.secrets(/|$)',
        '^node_modules(/|$)',
        '^dist(/|$)',
        '^assets(/|$)',
        '^config\.json$',
        '(^|/)nul(/|$)',
        '(^|/)[^/]+\.(db|sqlite|sqlite3|db-journal|sqlite-journal)$'
    )

    $mediaExtensions = '\.(jpg|jpeg|png|webp|gif|avif|bmp|tiff|tif|mp4|mov|avi|mkv|webm|wmv|flv|m4v)$'
    $mediaAllowList = @(
        '^docs/',
        '^public/',
        '^\.codex/skills/push/'
    )

    $blocked = New-Object System.Collections.Generic.List[string]
    foreach ($path in $Paths) {
        foreach ($pattern in $dangerousPatterns) {
            if ($path -match $pattern) {
                $blocked.Add($path)
                break
            }
        }

        if ($path -match $mediaExtensions) {
            $allowed = $false
            foreach ($allow in $mediaAllowList) {
                if ($path -match $allow) {
                    $allowed = $true
                    break
                }
            }
            if (-not $allowed) {
                $blocked.Add($path)
            }
        }
    }

    if ($blocked.Count -gt 0) {
        $unique = $blocked | Sort-Object -Unique
        Fail "Arquivos perigosos no worktree/stage. Remova ou confirme manualmente fora do /push:`n$($unique -join "`n")"
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
    foreach ($command in @('git', 'node', 'npm')) {
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

function Clear-DistBuildChanges {
    if (-not (Test-Path -LiteralPath 'dist')) {
        return
    }

    Run 'git' @('restore', '--worktree', '--', 'dist')
    Run 'git' @('clean', '-fd', '--', 'dist')
}

function Assert-BuildArtifact {
    if (-not (Test-Path -LiteralPath 'dist/GitMonitor-portable.exe')) {
        Fail 'Build nao gerou dist/GitMonitor-portable.exe'
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

    Assert-NoDangerousChangedPaths @(
        '.codex/skills/push/SKILL.md',
        'docs/example.png',
        'main.js'
    )

    $blocked = $false
    try {
        Assert-NoDangerousChangedPaths @('dist/GitMonitor-Setup-9.9.9.exe')
    }
    catch {
        $blocked = $true
    }

    if (-not $blocked) {
        Fail 'SelfTest falhou: caminho perigoso nao foi bloqueado'
    }

    Write-Host 'SelfTest OK'
}

if ($SelfTest) {
    Invoke-SelfTest
    exit 0
}

Write-Step 'Preflight'
Assert-GitMonitorRepo
Assert-GitPreflight
Assert-ReleasePreflight

$changedPaths = Get-ChangedPaths
Assert-NoDangerousChangedPaths $changedPaths

$packageJson = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$currentVersion = [string]$packageJson.version
$nextVersion = Get-NextPatchVersion $currentVersion
Assert-TagAvailable $nextVersion

Write-Host "Versao atual: $currentVersion"
Write-Host "Proxima versao patch: $nextVersion"

if ($PlanOnly) {
    Write-Host "PlanOnly ativo: nenhum arquivo sera alterado."
    exit 0
}

Write-Step 'Bump e validacoes'
Run 'npm' @('version', $nextVersion, '--no-git-tag-version')
Run 'npm' @('test')
Run 'npm' @('audit')

Write-Step 'Build Electron'
$previousAutoDiscovery = [Environment]::GetEnvironmentVariable('CSC_IDENTITY_AUTO_DISCOVERY', 'Process')
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
try {
    Run 'npm' @('run', 'build')
    Assert-BuildArtifact
}
finally {
    if ($null -eq $previousAutoDiscovery) {
        Remove-Item Env:\CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue
    }
    else {
        $env:CSC_IDENTITY_AUTO_DISCOVERY = $previousAutoDiscovery
    }
}

Write-Step 'Limpar artefatos locais'
Clear-DistBuildChanges
Assert-NoDangerousChangedPaths (Get-ChangedPaths)

Write-Step 'Commit, tag e push'
Run 'git' @('add', '-A', '--', '.', ':!dist/**')
$stagedStatus = & git diff --cached --name-only
if ($LASTEXITCODE -ne 0) {
    Fail "Nao foi possivel ler diff staged"
}
if (-not $stagedStatus) {
    Fail "Nenhuma mudanca staged para commit"
}

Run 'git' @('commit', '-m', "chore: publica Git Monitor v$nextVersion")
Run 'git' @('tag', '-a', "v$nextVersion", '-m', "Git Monitor v$nextVersion")
Run 'git' @('push', '--atomic', 'origin', 'master', "v$nextVersion")

Write-Host ""
Write-Host "Git Monitor v$nextVersion enviado com sucesso. O GitHub Actions publicara o release pela tag v$nextVersion." -ForegroundColor Green
