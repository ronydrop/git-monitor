#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/srv/git-monitor"
REPO_DIR="/srv/git-monitor/repo"
INCOMING_DIR="/srv/git-monitor/incoming"
LOG_DIR="/srv/git-monitor/logs"
LOCK_FILE="/run/lock/git-monitor-release.lock"
REMOTE_URL="https://github.com/ronydrop/git-monitor.git"
GITHUB_REPO="ronydrop/git-monitor"
GITHUB_WORKFLOW="Release"
ACTION_TIMEOUT_SECONDS="${GIT_MONITOR_ACTION_TIMEOUT_SECONDS:-1800}"
ACTION_POLL_SECONDS="${GIT_MONITOR_ACTION_POLL_SECONDS:-10}"

fail() {
  echo "[git-monitor-release] $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  git-monitor-release --plan-only
  git-monitor-release --validate-package <package.tgz>
  git-monitor-release --apply <package.tgz>
USAGE
}

run() {
  echo ">> $*"
  "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "comando obrigatorio nao encontrado: $1"
}

find_release_run_id() {
  local tag_name="$1"
  local commit_sha="$2"
  gh run list \
    --repo "$GITHUB_REPO" \
    --workflow "$GITHUB_WORKFLOW" \
    --limit 50 \
    --json databaseId,headSha,headBranch,event \
    --jq ".[] | select(.headSha == \"$commit_sha\" and .headBranch == \"$tag_name\" and .event == \"push\") | .databaseId" \
    | head -n 1
}

release_run_status() {
  local run_id="$1"
  gh run view "$run_id" \
    --repo "$GITHUB_REPO" \
    --json status,conclusion \
    --jq '.status + " " + (.conclusion // "")'
}

publish_github_bridge_release() {
  local tag_name="$1"
  local artifact_dir="$2"
  local version="${tag_name#v}"
  local latest_yml="$artifact_dir/latest.yml"
  local setup_exe="$artifact_dir/GitMonitor-Setup-$version.exe"
  local setup_blockmap="$artifact_dir/GitMonitor-Setup-$version.exe.blockmap"
  local portable_exe="$artifact_dir/GitMonitor-portable.exe"
  local notes="Release ponte para clientes antigos do Git Monitor que ainda consultam GitHub Releases. Versoes novas usam https://updates.botjarvis.com.br/git-monitor/."

  [[ -f "$latest_yml" ]] || fail "latest.yml ausente no artifact: $latest_yml"
  [[ -f "$setup_exe" ]] || fail "setup NSIS ausente no artifact: $setup_exe"
  [[ -f "$setup_blockmap" ]] || fail "blockmap ausente no artifact: $setup_blockmap"
  [[ -f "$portable_exe" ]] || fail "portable ausente no artifact: $portable_exe"

  if gh release view "$tag_name" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
    run gh release upload "$tag_name" \
      "$latest_yml" \
      "$setup_exe" \
      "$setup_blockmap" \
      "$portable_exe" \
      --repo "$GITHUB_REPO" \
      --clobber
    run gh release edit "$tag_name" \
      --repo "$GITHUB_REPO" \
      --title "$version" \
      --notes "$notes" \
      --draft=false \
      --prerelease=false \
      --latest
  else
    run gh release create "$tag_name" \
      "$latest_yml" \
      "$setup_exe" \
      "$setup_blockmap" \
      "$portable_exe" \
      --repo "$GITHUB_REPO" \
      --title "$version" \
      --notes "$notes" \
      --verify-tag \
      --latest
  fi
}

wait_for_release_artifact() {
  local tag_name="$1"
  local commit_sha="$2"
  local artifact_name="git-monitor-artifacts-$tag_name"
  local deadline=$(( $(date +%s) + ACTION_TIMEOUT_SECONDS ))
  local run_id=""

  while [[ $(date +%s) -lt $deadline ]]; do
    if [[ -z "$run_id" ]]; then
      run_id="$(find_release_run_id "$tag_name" "$commit_sha" || true)"
      if [[ -n "$run_id" ]]; then
        echo "GitHub Actions run encontrado: $run_id"
      fi
    fi

    if [[ -n "$run_id" ]]; then
      local status_line status conclusion
      status_line="$(release_run_status "$run_id")"
      status="${status_line%% *}"
      conclusion="${status_line#* }"
      echo "GitHub Actions run $run_id: status=$status conclusion=${conclusion:-pending}"

      if [[ "$status" == "completed" ]]; then
        [[ "$conclusion" == "success" ]] || fail "GitHub Actions falhou para $tag_name: conclusion=$conclusion run=$run_id"

        local artifact_dir package_path
        artifact_dir="$(mktemp -d "$ROOT_DIR/artifact.$tag_name.XXXXXX")"
        package_path="$INCOMING_DIR/git-monitor-$tag_name-artifacts.tgz"
        run gh run download "$run_id" --repo "$GITHUB_REPO" --name "$artifact_name" --dir "$artifact_dir"
        run tar -czf "$package_path" -C "$artifact_dir" .
        run git-monitor-promote-artifacts "$package_path" "$tag_name"
        run publish_github_bridge_release "$tag_name" "$artifact_dir"
        rm -rf "$artifact_dir"
        echo "Git Monitor $tag_name publicado no feed da VPS e no GitHub Releases."
        return 0
      fi
    else
      echo "Aguardando GitHub Actions iniciar para $tag_name ($commit_sha)"
    fi

    sleep "$ACTION_POLL_SECONDS"
  done

  fail "timeout aguardando GitHub Actions/artifact para $tag_name"
}

read_json() {
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
    const expression = process.argv[2];
    const fn = new Function("data", expression);
    fn(data);
  ' "$1" "$2"
}

require_safe_path() {
  local path="$1"
  [[ -n "$path" ]] || fail "path vazio no pacote"
  [[ "$path" != /* ]] || fail "path absoluto bloqueado: $path"
  [[ "$path" != *".."* ]] || fail "path com .. bloqueado: $path"
  case "$path" in
    .secrets/*|node_modules/*|dist/*|assets/*|config.json|*/nul/*|nul/*)
      fail "path perigoso bloqueado: $path"
      ;;
  esac
  if [[ "$path" =~ \.(db|sqlite|sqlite3|db-journal|sqlite-journal)$ ]]; then
    fail "arquivo de banco bloqueado: $path"
  fi
  if [[ "$path" =~ \.(jpg|jpeg|png|webp|gif|avif|bmp|tiff|tif|mp4|mov|avi|mkv|webm|wmv|flv|m4v)$ ]]; then
    case "$path" in
      docs/*|public/*|.codex/skills/push/*) ;;
      *) fail "arquivo de midia bloqueado: $path" ;;
    esac
  fi
}

require_ignored_path() {
  local path="$1"
  [[ -n "$path" ]] || fail "path ignorado vazio no pacote"
  [[ "$path" != /* ]] || fail "path ignorado absoluto bloqueado: $path"
  [[ "$path" != *".."* ]] || fail "path ignorado com .. bloqueado: $path"
  case "$path" in
    dist/*) ;;
    *) fail "path ignorado nao permitido: $path" ;;
  esac
}

ensure_layout() {
  mkdir -p "$ROOT_DIR" "$INCOMING_DIR" "$LOG_DIR"
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    run git clone "$REMOTE_URL" "$REPO_DIR"
  fi
}

assert_repo() {
  cd "$REPO_DIR"
  local origin
  origin="$(git remote get-url origin)"
  [[ "$origin" =~ github\.com[:/]+ronydrop/git-monitor(\.git)?$ ]] || fail "remote origin inesperado: $origin"
}

next_patch_version() {
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const m = String(pkg.version || "").match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    if (!m) throw new Error(`versao invalida: ${pkg.version}`);
    console.log(`${m[1]}.${m[2]}.${Number(m[3]) + 1}`);
  '
}

next_patch_version_from_ref() {
  local ref="$1"
  git show "$ref:package.json" | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const pkg = JSON.parse(input.replace(/^\uFEFF/, ""));
      const m = String(pkg.version || "").match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
      if (!m) throw new Error(`versao invalida: ${pkg.version}`);
      console.log(`${m[1]}.${m[2]}.${Number(m[3]) + 1}`);
    });
  '
}

validate_manifest_paths() {
  local manifest="$1"
  mapfile -t manifest_paths < <(read_json "$manifest" '
    for (const key of ["trackedPaths", "untrackedPaths"]) {
      for (const value of data[key] || []) console.log(value);
    }
  ')

  for path in "${manifest_paths[@]}"; do
    require_safe_path "$path"
  done

  mapfile -t ignored_paths < <(read_json "$manifest" '
    for (const value of data.ignoredPaths || []) console.log(value);
  ')

  for path in "${ignored_paths[@]}"; do
    require_ignored_path "$path"
  done
}

validate_package() {
  local package_path="$1"
  [[ -f "$package_path" ]] || fail "pacote nao encontrado: $package_path"

  local work_dir
  work_dir="$(mktemp -d)"
  trap 'rm -rf "${work_dir:-}"' RETURN
  run tar -xzf "$package_path" -C "$work_dir"

  [[ -f "$work_dir/manifest.json" ]] || fail "manifest.json ausente no pacote"
  [[ -f "$work_dir/changes.patch" ]] || fail "changes.patch ausente no pacote"
  validate_manifest_paths "$work_dir/manifest.json"
  echo "Pacote valido para validacao de paths."
}

apply_package() {
  local package_path="$1"
  [[ -f "$package_path" ]] || fail "pacote nao encontrado: $package_path"
  require_command gh
  require_command git-monitor-promote-artifacts

  ensure_layout
  assert_repo

  local work_dir
  work_dir="$(mktemp -d "$ROOT_DIR/apply.XXXXXX")"
  trap 'rm -rf "${work_dir:-}"' EXIT
  run tar -xzf "$package_path" -C "$work_dir"

  [[ -f "$work_dir/manifest.json" ]] || fail "manifest.json ausente no pacote"
  [[ -f "$work_dir/changes.patch" ]] || fail "changes.patch ausente no pacote"
  validate_manifest_paths "$work_dir/manifest.json"

  cd "$REPO_DIR"
  run git fetch origin +refs/heads/master:refs/remotes/origin/master --tags
  run git checkout master
  run git reset --hard refs/remotes/origin/master
  run git clean -fd

  local base_head
  base_head="$(read_json "$work_dir/manifest.json" 'console.log(data.baseHead || "")')"
  local current_head
  current_head="$(git rev-parse HEAD)"
  [[ -z "$base_head" || "$base_head" == "$current_head" ]] || fail "baseHead do pacote ($base_head) difere de origin/master ($current_head)"

  if [[ -s "$work_dir/changes.patch" ]]; then
    run git apply --binary "$work_dir/changes.patch"
  fi

  if [[ -d "$work_dir/untracked" ]]; then
    (cd "$work_dir/untracked" && tar -cf - .) | tar -xf - -C "$REPO_DIR"
  fi

  run git rm -r --cached --ignore-unmatch dist
  rm -rf dist

  if [[ -z "$(git status --porcelain=v1)" ]]; then
    fail "pacote nao gerou mudancas no clone remoto"
  fi

  run npm ci
  run npm test
  run npm audit
  run git diff --check

  local next_version
  next_version="$(next_patch_version)"
  if git rev-parse -q --verify "refs/tags/v$next_version" >/dev/null; then
    fail "tag local ja existe: v$next_version"
  fi
  if git ls-remote --exit-code --tags origin "refs/tags/v$next_version" >/dev/null 2>&1; then
    fail "tag remota ja existe: v$next_version"
  fi

  run npm version "$next_version" --no-git-tag-version
  run git add -A -- . ':!dist/**'
  if [[ -z "$(git diff --cached --name-only)" ]]; then
    fail "nenhuma mudanca staged para commit"
  fi
  run git commit -m "chore: publica Git Monitor v$next_version"
  run git tag -a "v$next_version" -m "Git Monitor v$next_version"
  run git push --atomic origin master "v$next_version"
  wait_for_release_artifact "v$next_version" "$(git rev-parse HEAD)"
}

plan_only() {
  require_command git
  require_command node
  require_command npm
  require_command tar
  require_command flock
  require_command gh
  ensure_layout
  assert_repo
  cd "$REPO_DIR"
  run git fetch origin +refs/heads/master:refs/remotes/origin/master --tags
  echo "repo=$REPO_DIR"
  echo "incoming=$INCOMING_DIR"
  echo "public=/var/www/local-dev-watcher-updates/git-monitor"
  echo "current=$(git rev-parse --short refs/remotes/origin/master)"
  echo "next=$(next_patch_version_from_ref refs/remotes/origin/master)"
}

main() {
  local command="${1:-}"
  case "$command" in
    --plan-only)
      plan_only
      ;;
    --validate-package)
      local package_path="${2:-}"
      [[ -n "$package_path" ]] || fail "--validate-package exige caminho do pacote"
      validate_package "$package_path"
      ;;
    --apply)
      local package_path="${2:-}"
      [[ -n "$package_path" ]] || fail "--apply exige caminho do pacote"
      mkdir -p "$(dirname "$LOCK_FILE")" "$ROOT_DIR" "$INCOMING_DIR" "$LOG_DIR"
      (
        flock -n 9 || fail "release ja esta rodando"
        local log_file="$LOG_DIR/release-$(date -u +%Y%m%dT%H%M%SZ).log"
        apply_package "$package_path" 2>&1 | tee "$log_file"
      ) 9>"$LOCK_FILE"
      ;;
    -h|--help|"")
      usage
      ;;
    *)
      usage
      fail "argumento desconhecido: $command"
      ;;
  esac
}

main "$@"
