#!/usr/bin/env bash
# Install the AI Usage applet on this machine.
#
# Idempotent: safe to re-run after pulling changes. It never edits the panel
# layout -- adding the applet stays a deliberate act in Cinnamon's own UI.
set -euo pipefail

UUID="ai-usage@voccer"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APPLET_SOURCE="$SOURCE_DIR/$UUID"
APPLET_TARGET="$HOME/.local/share/cinnamon/applets/$UUID"

fail() { printf 'error: %s\n' "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }

[ -d "$APPLET_SOURCE" ] || fail "$APPLET_SOURCE is missing; run this from a full checkout"

echo "Checking prerequisites"
for binary in cinnamon python3 gsettings; do
    command -v "$binary" >/dev/null 2>&1 || fail "$binary is required but not installed"
done
note "cinnamon, python3, gsettings: ok"

# Not a pipeline: `grep -q` exits at the first match, `tr` then dies on SIGPIPE,
# and `set -o pipefail` would report the whole check as a failure.
FONT_FAMILIES="$(fc-list : family 2>/dev/null | tr ',' '\n' || true)"
if printf '%s\n' "$FONT_FAMILIES" | grep -qx "Inter"; then
    note "Inter font: ok"
else
    note "Inter font: MISSING -- the detail table falls back to sans-serif."
    note "  install with: sudo apt install fonts-inter"
fi

# `which codex` under fnm returns /run/user/<uid>/fnm_multishells/<pid>_<ts>/bin/codex,
# which is recreated per shell and is gone by the time Cinnamon reads the setting.
find_codex() {
    local candidate
    for candidate in \
        "${CODEX_BIN:-}" \
        "${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/codex" \
        "$HOME/.local/bin/codex" \
        /usr/local/bin/codex \
        /usr/bin/codex
    do
        [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
    done

    candidate="$(command -v codex 2>/dev/null || true)"
    # A multishell hit still names a real install: resolve the shell-local
    # directory to the node-versions one it points at, which outlives the shell.
    case "$candidate" in
        /run/user/*) candidate="$(readlink -f "${candidate%/bin/codex}" || true)/bin/codex" ;;
    esac
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
    return 1
}

find_codex_home() {
    local candidate
    for candidate in "${CODEX_HOME:-}" "$HOME/.codex"; do
        [ -n "$candidate" ] && [ -d "$candidate" ] && { printf '%s' "$candidate"; return 0; }
    done
    return 1
}

CODEX_PATH="$(find_codex || true)"
CODEX_CONFIG="$(find_codex_home || true)"

echo "Installing the applet"
if [ -L "$APPLET_TARGET" ]; then
    ln -sfn "$APPLET_SOURCE" "$APPLET_TARGET"
    note "relinked $APPLET_TARGET"
elif [ -e "$APPLET_TARGET" ]; then
    fail "$APPLET_TARGET exists and is not a symlink; move it aside first"
else
    mkdir -p "$(dirname "$APPLET_TARGET")"
    ln -s "$APPLET_SOURCE" "$APPLET_TARGET"
    note "linked $APPLET_TARGET -> $APPLET_SOURCE"
fi

echo "Checking Codex"
if [ -n "$CODEX_PATH" ]; then
    note "executable: $CODEX_PATH"
else
    note "executable: NOT FOUND -- set it by hand in the applet settings."
    note "  Do not paste the output of \`which codex\` if you use fnm; it is ephemeral."
fi
[ -n "$CODEX_CONFIG" ] && note "CODEX_HOME: $CODEX_CONFIG" || note "CODEX_HOME: NOT FOUND"

# Seed any settings instance that already exists; a first install has none yet,
# and Cinnamon writes it from settings-schema.json when the applet first loads.
CONFIG_DIR="$HOME/.config/cinnamon/spices/$UUID"
if [ -d "$CONFIG_DIR" ] && [ -n "$CODEX_PATH" ]; then
    for config in "$CONFIG_DIR"/*.json; do
        [ -e "$config" ] || continue
        CODEX_PATH="$CODEX_PATH" CODEX_CONFIG="$CODEX_CONFIG" python3 - "$config" <<'PY'
import json, os, sys

path = sys.argv[1]
with open(path) as handle:
    data = json.load(handle)

changed = False
for key, value in (("codex-executable-path", os.environ.get("CODEX_PATH")),
                   ("codex-home-path", os.environ.get("CODEX_CONFIG"))):
    if value and key in data and data[key].get("value") != value:
        data[key]["value"] = value
        changed = True

if changed:
    with open(path, "w") as handle:
        json.dump(data, handle, indent=4)
    print(f"  updated Codex paths in {os.path.basename(path)}")
PY
    done
fi

cat <<EOF

Done. Next:
  1. Right-click the panel -> Applets -> enable "AI Usage".
  2. Its settings hold the Claude credentials path, the Codex paths, and a
     toggle per provider.

Notes:
  - Claude reads the OAuth token Claude Code maintains at ~/.claude/.credentials.json,
    so sign in with Claude Code first. The applet never refreshes that token itself.
  - After editing anything under $UUID/lib/, restart Cinnamon (Ctrl+Alt+Esc).
    Reloading the applet is not enough: GJS caches imports for the process lifetime.
EOF
