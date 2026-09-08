# Changelog

## Unreleased

- Render the panel one step below Cinnamon's `applet-label` size (`0.9em`).
  At the stock 1em this applet reads as oversized next to a clock, because it
  carries several times as much text at the same size.

- Split each panel reading into a name label and a value label so a cramped
  panel ellipsizes the provider name instead of the percentage. Previously the
  whole reading was one label that ellipsized from the end, hiding the number
  and keeping the word.

- Derive all secondary tooltip text from the theme's own tooltip colour instead
  of fixed greys, so the detail table stays readable on themes other than
  Mint-Y-Dark-Grey.

- Add `install.sh`: prerequisite checks, an idempotent symlink install, and
  Codex path detection that rejects fnm's ephemeral `/run/user/...` shims.
- Make every settings default `~`-relative so no default carries one user's
  home directory onto another machine.

- Drop the panel icon so the applet shows only its readings.
- Render the hover panel as an aligned table with per-window usage bars,
  colored percentages, and compact reset times.
- Show a provider's status line only when it is degraded, and give reset times
  the strongest emphasis in the table.
- Add `Show Claude usage` and `Show Codex usage` settings; a disabled provider
  is hidden from the panel and hover text and stops being polled.
- Left-align the hover panel so themes that center `#Tooltip` no longer stagger
  its rows, and set it in Inter with tabular figures and figure-space padding so
  the columns stay aligned in a proportional face.
- Left-click a reading to launch that provider's desktop app and middle-click to
  refresh it; the launched entry is configurable per provider.
- Never let a forced refresh poll inside a server-issued `Retry-After` window,
  which previously turned one HTTP 429 into a self-renewing one.
- Repaint the panel once settings are bound. The first paint happens before the
  bindings exist and so assumed both providers were enabled; because only a poll
  repaints afterwards, disabling both left the stale readings on screen forever.
- Declare the applet icon in `metadata.json` so it still appears in Cinnamon's
  applet list now that the panel shows no icon.

## 1.0.0 - 2026-09-07

- Combine Claude and Codex short-window usage in one Cinnamon panel item.
- Add detailed hover text for both short and long windows.
- Keep cached values visible during OAuth expiry, rate limiting, and outages.
- Recover from Claude credential replacement and use bounded provider retries.
- Query Codex through a sanitized, short-lived `codex app-server` adapter.
