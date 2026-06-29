#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_SRC="$ROOT/skills/linkedin-lead-enrichment"
DEFAULT_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
TARGET="${1:-$DEFAULT_SKILLS_DIR/linkedin-lead-enrichment}"

if [[ ! -f "$SKILL_SRC/SKILL.md" ]]; then
  echo "Skill source not found at $SKILL_SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
cp -R "$SKILL_SRC" "$TARGET"

echo "Installed linkedin-lead-enrichment skill to $TARGET"
echo "Invoke in Codex with: Use \$linkedin-lead-enrichment to run the guided workflow."
