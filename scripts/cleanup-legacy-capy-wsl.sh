#!/usr/bin/env bash
# Remove only the verified legacy WSL Capybara Code installation and its exact shell wiring.
set -euo pipefail

apply=false
case "${1:-}" in
  "") ;;
  --apply) apply=true ;;
  *) echo "usage: $0 [--apply]" >&2; exit 2 ;;
esac

legacy_root="$HOME/.local/lib/capybara-code"
legacy_bin="$legacy_root/bin/capy"
legacy_runtime="$legacy_root/libexec/cbc-runtime"
legacy_map="$legacy_root/bin/main.js.map"
legacy_backup="$legacy_root/libexec/cbc-runtime.bak-20260812"
bashrc="$HOME/.bashrc"
path_line='export PATH="$HOME/.local/lib/capybara-code/bin:$PATH"'
source_alias_pattern='^alias capy="bun run /mnt/[A-Za-z]/Users/[^\"]*/Capybara-Code/apps/cbc/src/main\.ts"$'
legacy_dist_alias_pattern='^alias capy="/mnt/[A-Za-z]/Users/[^\"]*/Capybara-Code/dist/capybara-code-[^/\"]+-linux-x64/bin/capy"$'

die() {
  echo "error: $*" >&2
  exit 1
}

legacy_bashrc_line() {
  local line="$1"
  [[ "$line" == "$path_line" || "$line" =~ $source_alias_pattern || "$line" =~ $legacy_dist_alias_pattern ]]
}

plan() {
  if "$apply"; then
    printf 'APPLY  %s\n' "$*"
  else
    printf 'DRY RUN  %s\n' "$*"
  fi
}

remove_root=false
if [[ -e "$legacy_root" || -L "$legacy_root" ]]; then
  resolved_root="$(realpath -e "$legacy_root")"
  [[ "$resolved_root" == "$legacy_root" ]] || die "refusing unexpected legacy root target: $resolved_root"
  [[ -x "$legacy_bin" ]] || die "refusing $legacy_root: bin/capy is missing or not executable"
  [[ -x "$legacy_runtime" ]] || die "refusing $legacy_root: libexec/cbc-runtime is missing or not executable"
  [[ -f "$legacy_map" ]] || die "refusing $legacy_root: expected legacy source map is missing"
  [[ -f "$legacy_backup" ]] || die "refusing $legacy_root: expected legacy runtime backup is missing"
  [[ -d "$legacy_root/share/capybara" ]] || die "refusing $legacy_root: share/capybara is missing"
  remove_root=true
  plan "remove verified legacy WSL install $legacy_root"
fi

removed_bashrc_lines=0
if [[ -f "$bashrc" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if legacy_bashrc_line "$line"; then
      removed_bashrc_lines=$((removed_bashrc_lines + 1))
      plan "remove legacy .bashrc line: $line"
    fi
  done < "$bashrc"
fi

if ! "$remove_root" && (( removed_bashrc_lines == 0 )); then
  echo 'Nothing to clean: the verified WSL Capybara Code legacy installation and shell wiring are absent.'
fi

if "$apply"; then
  if (( removed_bashrc_lines > 0 )); then
    temporary_bashrc="$(mktemp "${bashrc}.capybara-clean.XXXXXX")"
    while IFS= read -r line || [[ -n "$line" ]]; do
      legacy_bashrc_line "$line" && continue
      printf '%s\n' "$line"
    done < "$bashrc" > "$temporary_bashrc"
    chmod --reference="$bashrc" "$temporary_bashrc"
    mv -- "$temporary_bashrc" "$bashrc"
  fi
  if "$remove_root"; then
    rm -rf -- "$legacy_root"
  fi
  echo 'WSL legacy cleanup complete. Open a new interactive WSL terminal before checking command resolution.'
else
  echo 'No files or shell configuration were changed. Re-run with --apply after review.'
fi

echo 'Safety note: /usr/bin/cbc is the Coin-OR solver and is intentionally untouched.'
