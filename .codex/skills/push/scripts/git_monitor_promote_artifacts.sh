#!/usr/bin/env bash
set -euo pipefail

PUBLIC_DIR="/var/www/local-dev-watcher-updates/git-monitor"
ROOT_DIR="/srv/git-monitor"
LOCK_FILE="/run/lock/git-monitor-artifacts.lock"

fail() {
  echo "[git-monitor-promote-artifacts] $*" >&2
  exit 1
}

run() {
  echo ">> $*"
  "$@"
}

package_path="${1:-}"
tag_name="${2:-}"
[[ -n "$package_path" ]] || fail "uso: git-monitor-promote-artifacts <package.tgz> <vX.Y.Z>"
[[ -f "$package_path" ]] || fail "pacote nao encontrado: $package_path"
[[ "$tag_name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "tag invalida: $tag_name"

version="${tag_name#v}"
release_dir="$PUBLIC_DIR/releases/$version"
staging_dir="$PUBLIC_DIR/.staging-$version-$$"

mkdir -p "$(dirname "$LOCK_FILE")" "$PUBLIC_DIR/releases" "$ROOT_DIR/logs"

(
  flock -n 9 || fail "promocao de artefatos ja esta rodando"
  rm -rf "$staging_dir"
  mkdir -p "$staging_dir"
  run tar -xzf "$package_path" -C "$staging_dir"

  for file in \
    "latest.yml" \
    "GitMonitor-Setup-$version.exe" \
    "GitMonitor-Setup-$version.exe.blockmap" \
    "GitMonitor-portable.exe"; do
    [[ -f "$staging_dir/$file" ]] || fail "artifact ausente: $file"
  done

  grep -Fq "GitMonitor-Setup-$version.exe" "$staging_dir/latest.yml" || fail "latest.yml nao aponta para GitMonitor-Setup-$version.exe"

  rm -rf "$release_dir"
  mv "$staging_dir" "$release_dir"

  cp "$release_dir/latest.yml" "$PUBLIC_DIR/latest.yml.tmp"
  mv "$PUBLIC_DIR/latest.yml.tmp" "$PUBLIC_DIR/latest.yml"
  cp "$release_dir/GitMonitor-Setup-$version.exe" "$PUBLIC_DIR/GitMonitor-Setup-$version.exe"
  cp "$release_dir/GitMonitor-Setup-$version.exe.blockmap" "$PUBLIC_DIR/GitMonitor-Setup-$version.exe.blockmap"
  cp "$release_dir/GitMonitor-portable.exe" "$PUBLIC_DIR/GitMonitor-portable.exe"
  chmod -R a+rX "$PUBLIC_DIR"
  echo "Git Monitor $version publicado em $PUBLIC_DIR"
) 9>"$LOCK_FILE"
