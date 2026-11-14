#!/usr/bin/env bash
# Links the office's scripts, skills and agy plugin from this folder into place, so this folder stays the one source.
# Safe to run again. Accounts are not touched: each one signs in once with `agy-as accN` (see README.md).
set -eu
here=$(dirname "$(readlink -f "$0")")
bin="$HOME/.local/bin"
skills="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
commands="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands"
root="${HABBLAUD_AGY_PROFILES:-$HOME/.agy_profiles}"
mkdir -p "$bin" "$skills" "$commands"

for f in agy-as office-boss office_rules.py rules-hook; do ln -sfn "$here/bin/$f" "$bin/$f"; done
ln -sfn "$here/bin/worker-ask" "$bin/agy-ask"
ln -sfn agy-ask "$bin/claude-ask"
for s in "$here"/skills/*/; do ln -sfn "${s%/}" "$skills/$(basename "$s")"; done
for c in "$here"/commands/*.md; do ln -sfn "$c" "$commands/$(basename "$c")"; done  # /boss, /workers, /quota, /offices, /office

# agy skips a symlinked plugin folder, and `agy plugin install` copies without office_rules.py: a real folder of links.
for p in "$root"/acc*/; do
  [ -d "$p" ] || continue
  d="$p.gemini/config/plugins/office-rules"
  [ -L "$d" ] && rm -f "$d"
  mkdir -p "$d"
  ln -sfn "$here"/agy-plugin/office-rules/* "$d"/
  [ -e "$p.gemini/GEMINI.md" ] || ln -sfn "$here/worker-rules/GEMINI.md" "$p.gemini/GEMINI.md"
done
echo "Installed from $here. In a running Claude Code session: /reload-plugins."
case ":$PATH:" in *":$bin:"*) ;; *) echo "Add $bin to your PATH." ;; esac
