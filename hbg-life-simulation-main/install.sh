#!/usr/bin/env bash
# Install this skill into a local skills directory by copying it from the checkout
# the script lives in. No network access, no third-party downloads.
set -euo pipefail

skill_name="hbg-life-simulation"
install_kind="codex"
custom_target=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --claude                    Install into the Claude Code skills directory (~/.claude/skills).
  --target <skills-directory> Install into a custom skills directory.
  -h, --help                  Show this help.

Default target: ${CODEX_HOME:-~/.codex}/skills
Copy .env.example to .env in your project and fill in the image API / ComfyUI values.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude) install_kind="claude"; shift ;;
    --target)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      custom_target=$2
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "Missing required command: node" >&2; exit 2; }

source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for required in SKILL.md agents assets references scripts; do
  [[ -e "$source_dir/$required" ]] || { echo "Incomplete checkout, missing: $required" >&2; exit 2; }
done

if [[ -n "$custom_target" ]]; then
  skills_root=$custom_target
elif [[ "$install_kind" == "claude" ]]; then
  skills_root="$HOME/.claude/skills"
elif [[ -n "${CODEX_HOME:-}" ]]; then
  skills_root="$CODEX_HOME/skills"
else
  skills_root="$HOME/.codex/skills"
fi

target_dir="$skills_root/$skill_name"
mkdir -p "$skills_root"
if [[ -e "$target_dir" ]]; then
  backup_dir="${target_dir}.backup.$(date +%Y%m%d-%H%M%S)"
  mv "$target_dir" "$backup_dir"
  echo "Backed up existing skill to $backup_dir"
fi

mkdir -p "$target_dir"
cp "$source_dir/SKILL.md" "$target_dir/SKILL.md"
cp "$source_dir/.env.example" "$target_dir/.env.example"
cp -R "$source_dir/agents" "$target_dir/agents"
cp -R "$source_dir/assets" "$target_dir/assets"
cp -R "$source_dir/references" "$target_dir/references"
cp -R "$source_dir/scripts" "$target_dir/scripts"
chmod +x "$target_dir/scripts/"*.sh

test -f "$target_dir/SKILL.md"
for script in "$target_dir/scripts/"*.sh; do bash -n "$script"; done
for script in "$target_dir/scripts/"*.mjs "$target_dir/scripts/lib/"*.mjs; do node --check "$script"; done

echo "Installed $skill_name to $target_dir"
echo "Invoke it as \$$skill_name"
