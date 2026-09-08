# AI Usage Cinnamon Applet

`AI Usage` is a Cinnamon panel applet that shows Claude and Codex subscription
usage together:

```text
Claude 35% · Codex 48%
```

The panel renders at `0.9em`, one step below Cinnamon's `applet-label` size,
set in `stylesheet.css`. The hover table is separate and follows the theme.

The panel shows each enabled provider's short window and nothing else — no
icon. Each reading is two labels, and only the name may ellipsize: when the
panel runs short of room it gives up `Claude` before it gives up `34%`, because
the number is the part worth reading. A very cramped panel therefore shows
`… 34% · … 0%` — the leftover ellipsis is the cost of keeping the name in the
layout, which is what lets it come back when the panel has room again. Hovering opens an aligned detail table:

```text
Claude
  5h   ██████░░░░░░░░  43%   ↺ Sep 8 03:10
  7d   █░░░░░░░░░░░░░   5%   ↺ Sep 14 21:00

Codex  plus
  5h   ██████████████ 100%   ↺ Sep 8 02:16
  7d   ████████░░░░░░  56%   ↺ Sep 13 00:06

Updated 23:38
```

Reset times are the boldest thing in the table: they answer "when do I get
capacity back". They and every other piece of secondary text take the colour the
theme already set on `#Tooltip` — dimmed to 60% alpha where they should recede —
rather than a fixed hex. A fixed hex only suits the theme it was picked against:
`#9aa0a6` scores 2.08 contrast on `Mint-Y-Dark-Grey` but 1.35 on
`Mint-Y-Dark-Aqua`, which is unreadable.

The bar and percentage colours are still fixed, because they carry meaning.
They are tuned for a dark background and lose contrast on a light or mid-tone
tooltip: on `Mint-Y-Dark-Aqua` the danger red scores 1.28. No single palette
fixes this — raising lightness until all three clear 3.0 collapses them to
near-white (`#d2f4dd`, `#faecc2`, `#fbe9e9`) and lowering it collapses them to
near-black, either way losing the hue separation that makes them mean anything.
Keeping them legible everywhere needs the tooltip to have a known background. A provider only gets a status line when something is wrong
(`Cached`, `Sign in required`, `Rate limited`, `Temporarily unavailable`) —
a healthy one says nothing, since "Current" on every block is just noise.

Bars and percentages are colored by the same thresholds as the panel: green
below 70%, amber from 70%, red from 85%, amber for any degraded provider. The
unused part of each bar keeps the same hue at low alpha so a row reads as one
gauge. Reset times collapse to a clock when they fall on the current day.

The table is left-aligned explicitly, because several themes — Mint-Y among
them — set `text-align: center` on `#Tooltip`, which makes every row drift by
half the difference in its rendered width.

It is set in Inter, falling back to `sans-serif`. Inter's default figures are
proportional (`0` is 1760 units wide, `1` is 1308), so the markup enables
`font_features="tnum=1"` and pads columns with U+2007 FIGURE SPACE, which is
exactly one tabular digit wide — a plain space is not. Without both, the
percentage column staggers. Inter has no block-drawing glyphs, so the bars come
from the fallback face; every bar uses the same character count, so they still
align with each other.

## Clicking

Each reading is its own click target:

- Left-click a reading: launch that provider's desktop app through its desktop
  entry, so startup notification and single-instance focusing behave the same
  as launching from the menu.
- Middle-click a reading: refresh just that provider.
- Right-click: unhandled on purpose, so Cinnamon's own panel menu still opens.

A refresh may skip the applet's own backoff, but never a `Retry-After` window
the server issued — retrying inside that window only renews the penalty.

## Reliability and authentication

Claude reads the OAuth access token maintained by Claude Code at
`~/.claude/.credentials.json`. The applet never exchanges or persists the
refresh token. When the access token expires or returns HTTP 401, cached usage
stays visible with `⚠`; credentials are checked every minute and any atomic
file replacement is detected by monitoring the parent directory. HTTP 429
honors `Retry-After`, otherwise retries back off through 1, 2, 4, 8, and 15
minutes.

Codex usage is read through the documented `codex app-server`
`account/rateLimits/read` method. The Python adapter never opens `auth.json`
and emits only normalized usage windows and plan type. Its subprocess is
short-lived and asynchronous from Cinnamon's point of view.

Provider timers and failures are independent. The last successful normalized
state is cached at `~/.cache/ai-usage@voccer/state.json` with mode `0600`; no
token or account ID is stored there.

## Settings

- Show Claude usage / Show Codex usage: both enabled by default. Turning one off
  hides it from the panel and the hover table, stops its timer, and — for Codex —
  stops spawning the adapter. The other provider is unaffected, and disabling
  both leaves an `AI Usage off` placeholder so the applet stays clickable in
  panel edit mode.
- Claude desktop entry / Codex desktop entry: which `.desktop` file each
  reading launches, defaulting to `com.anthropic.Claude.desktop` and
  `codex-desktop.desktop`. If the entry is missing the click falls back to
  refreshing that provider.
- Update interval: 5 minutes by default.
- Claude credentials path: `~/.claude/.credentials.json`.
- Codex executable: `~/Desktop/shared/config/fnm/aliases/default/bin/codex`.
  Must be a stable path — see "Moving to another machine".
- Codex home: `~/Desktop/shared/config/codex`.

## Install

Get the repository onto the machine, then run:

```bash
./install.sh
```

It checks prerequisites, symlinks `ai-usage@voccer` into
`~/.local/share/cinnamon/applets/`, and detects the Codex executable and
`CODEX_HOME`, writing them into an existing settings instance. It is idempotent,
never touches the panel layout, and refuses to replace a real directory at the
install path. Then enable `AI Usage` from the panel's Applets dialog.

To install by hand instead:

```bash
ln -s "$PWD/ai-usage@voccer" ~/.local/share/cinnamon/applets/ai-usage@voccer
```

Inspect runtime messages with:

```bash
rg 'ai-usage@voccer' ~/.xsession-errors
```

### Moving to another machine

Everything the applet needs is in this repository except four machine-local
things:

1. **`fonts-inter`** — without it the detail table falls back to `sans-serif`.
   `install.sh` warns; `sudo apt install fonts-inter` fixes it.
2. **The Codex executable path.** This is the one that reliably goes wrong.
   Under fnm, `which codex` prints
   `/run/user/<uid>/fnm_multishells/<pid>_<timestamp>/bin/codex`, which is
   recreated per shell and is already gone when Cinnamon reads the setting.
   `install.sh` skips any `/run/user/...` candidate and prefers a stable path;
   override the search with `CODEX_BIN=/path/to/codex ./install.sh`.
3. **A Claude Code login**, since the applet reads the OAuth token Claude Code
   maintains at `~/.claude/.credentials.json` and never refreshes it itself.
4. **The desktop entries**, if you want click-to-open: `com.anthropic.Claude.desktop`
   and `codex-desktop.desktop` must exist, or the click falls back to refreshing.

Settings defaults are written `~`-relative and expanded at read time, so they do
not carry one user's home directory to another machine. A settings instance
(`~/.config/cinnamon/spices/ai-usage@voccer/<id>.json`) is per machine and is
created by Cinnamon from `settings-schema.json` on first load — it is not
something to copy across.

After editing `lib/usage.js`, reloading the applet is **not** enough: GJS caches
`imports.usage` for the lifetime of the Cinnamon process, so a reload keeps
running the old module and new helpers fail with
`TypeError: Usage.<name> is not a function`. Restart Cinnamon instead
(`Ctrl+Alt+Esc`, or `cinnamon --replace &` from a terminal). Edits to
`applet.js` alone are picked up by a plain reload.

## Test

```bash
python3 -m unittest -v
python3 -m py_compile ai-usage@voccer/codex_usage.py
jq empty ai-usage@voccer/metadata.json ai-usage@voccer/settings-schema.json
cjs -I ai-usage@voccer/lib tests/test_usage.js
git diff --check
```

## Rollback

Disable `ai-usage@voccer` and re-enable `claude-usage@mtwebster` at its former
panel position. The old applet directory is deliberately left installed.

## Attribution and license

The Claude integration and initial Cinnamon structure are based on
`claude-usage@mtwebster` version 1.1.0 by mtwebster. This project preserves
that applet's GPL-3.0 license; see [LICENSE](LICENSE).
