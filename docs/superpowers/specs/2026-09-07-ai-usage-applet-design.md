# AI Usage Cinnamon Applet Design

## Purpose

Build a Cinnamon panel applet named `AI Usage` that shows current Claude and
Codex subscription usage in one compact panel item. The applet replaces the
existing `claude-usage@mtwebster` panel item only after both providers have
been validated on this machine.

The canonical source will live at:

```text
/home/voccer/Desktop/shared/config/cinnamon/ai-usage-applet
```

The install location will be a symlink from:

```text
~/.local/share/cinnamon/applets/ai-usage@voccer
```

to the applet source directory in the canonical repository. The project will
retain GPL-3.0 licensing and attribution for the forked Claude applet code.

## Goals

- Show the short usage window for Claude and Codex directly on the panel.
- Show both short and weekly windows, reset times, freshness, and provider
  state in a multiline hover tooltip.
- Recover automatically from credential changes, temporary network errors,
  and rate limiting.
- Keep the last successful values visible while a provider is temporarily
  unavailable.
- Isolate Claude and Codex failures so one provider never hides the other.
- Avoid reading or refreshing Codex credentials directly.
- Avoid rotating Claude refresh tokens from the applet.
- Preserve an immediate rollback path to the installed Claude-only applet.

## Non-goals

- Tracking OpenAI API-platform billing or API-key rate limits.
- Tracking Anthropic Console API billing.
- Refreshing Claude OAuth credentials independently of Claude Code.
- Consuming Codex rate-limit reset credits.
- Adding charts, history, notifications, or a persistent background daemon.
- Publishing the applet to Cinnamon Spices in this iteration.

## Existing applet and observed failure

The installed applet is `claude-usage@mtwebster` version 1.1.0. It reads
`claudeAiOauth.accessToken` from `~/.claude/.credentials.json`, requests
`https://api.anthropic.com/api/oauth/usage`, and displays the five-hour and
seven-day utilization values.

Two code paths explain the unreliable display:

1. HTTP 401 and HTTP 429 both call `stopTimer()`. No future scheduled request
   is created, even though the 429 tooltip says the applet will retry.
2. The credential monitor watches the credential file and reacts only to
   `CHANGES_DONE_HINT`. An atomic replacement or rename can leave the monitor
   attached to the old file and prevent the new token from being loaded.

The local Cinnamon log confirms a sequence of credentials loading followed by
HTTP 401. At design time, the stored Claude access token had expired while the
refresh token was still valid, and `claude auth status` still reported
`oauth_token` authentication. The applet must therefore treat access-token
expiry as a recoverable provider state rather than a fatal applet state.

## Architecture

```text
ai-usage-applet/
├── ai-usage@voccer/
│   ├── applet.js
│   ├── codex_usage.py
│   ├── metadata.json
│   ├── settings-schema.json
│   ├── stylesheet.css
│   └── icons/
├── tests/
│   ├── fixtures/
│   └── test_codex_usage.py
├── docs/superpowers/specs/
├── LICENSE
└── README.md
```

`applet.js` owns Cinnamon integration, provider state, scheduling, Claude HTTP
requests, cache persistence, panel rendering, and tooltip rendering.

`codex_usage.py` is a short-lived adapter. It starts `codex app-server`,
performs the JSONL initialization handshake, calls
`account/rateLimits/read`, emits one normalized JSON object on stdout, and
terminates the child process. It never opens `auth.json` and never prints
tokens, account identifiers, or raw app-server messages.

The applet starts the adapter asynchronously through `Gio.Subprocess`, so the
Cinnamon UI thread never blocks. Claude and Codex maintain separate state and
separate next-attempt timestamps.

## Normalized provider state

Each provider is represented in memory with the same shape:

```text
name
shortWindow: { usedPercent, durationMinutes, resetsAt }
longWindow:  { usedPercent, durationMinutes, resetsAt }
metadata: { planType? }
lastSuccessAt
lastAttemptAt
status: fresh | stale | rate_limited | auth_required | unavailable
statusDetail
nextAttemptAt
```

Only this normalized, non-secret data may be persisted. The cache file is:

```text
~/.cache/ai-usage@voccer/state.json
```

It is written atomically with user-only permissions. Cache corruption is
ignored and replaced after the next successful refresh.

## Claude provider

The Claude provider preserves the working request format from the installed
applet:

- Credentials default to `~/.claude/.credentials.json` and remain
  configurable.
- The request uses the bearer `accessToken` and the existing
  `anthropic-beta: oauth-2025-04-20` header.
- Credentials are re-read immediately before each network request rather than
  retained indefinitely in memory.
- If `expiresAt` is in the past, the provider enters `auth_required` without
  sending a request that is known to fail.
- The monitor watches the parent directory. Any create, change, move, rename,
  or delete event affecting `.credentials.json` triggers a debounced reload.
- A changed credential fingerprint clears `auth_required` and schedules an
  immediate request. The fingerprint must be derived without logging or
  persisting the token.

The applet never exchanges `refreshToken`. Refresh-token rotation can conflict
with running Claude Code sessions. Claude Code remains the owner of its OAuth
lifecycle; after Claude Code refreshes or the user logs in, the directory
monitor detects the new credentials and the applet resumes automatically.

### Claude retry policy

- `401` or expired `expiresAt`: retain cached data, mark `auth_required`, check
  the local credential file every 60 seconds, and retry the API only after the
  credential changes or its expiry becomes valid.
- `429`: honor `Retry-After` when it is valid. Otherwise use delays of 1, 2, 4,
  8, and 15 minutes, capped at 15 minutes.
- Network errors and `5xx`: use the same capped backoff sequence.
- Other `4xx`: retain cached data, mark `unavailable`, and retry at the normal
  polling interval.
- Any successful response clears the failure count and backoff.

Manual refresh re-reads credentials immediately but does not bypass an active
server-provided `Retry-After` deadline.

## Codex provider

Codex usage comes from the documented Codex App Server method
`account/rateLimits/read`. The adapter uses:

```text
codex executable:
/home/voccer/Desktop/shared/config/fnm/aliases/default/bin/codex

CODEX_HOME:
/home/voccer/Desktop/shared/config/codex
```

Both paths are configurable in applet settings. The default executable path
uses the stable FNM `aliases/default` symlink so Node upgrades do not pin the
applet to a versioned installation directory.

The adapter sends `initialize`, then `initialized`, then
`account/rateLimits/read`. It selects the `codex` bucket, maps `primary` to the
short window and `secondary` to the long window, and validates numeric
percentages and Unix reset timestamps. Missing optional fields remain absent;
they do not fail the whole response.

The subprocess has a 10-second deadline. Startup failure, malformed JSONL,
missing authentication, missing buckets, or timeout produces a normalized
error without exposing raw credentials or account IDs. Codex uses the same
network/backoff policy as Claude, except there is no local credential polling;
it retries at its provider deadline.

## Scheduling and concurrency

The normal polling interval defaults to five minutes and is configurable from
1 to 60 minutes. Each provider owns its own timer and failure counter.

At startup, cached values render immediately, then both providers refresh when
eligible. A provider cannot start a second request while its previous request
is active. Clicking the applet requests refresh for both providers, subject to
an active `Retry-After` deadline. Removing the applet cancels timers, file
monitors, HTTP requests where supported, and child processes.

## Panel and tooltip

The horizontal panel renders one applet icon followed by two compact labels:

```text
Claude 35% · Codex 48%
```

Only the short-window percentages appear on the panel. A provider with no
successful data shows `--`. A stale or degraded provider keeps its last value
and appends `⚠`.

Usage colors follow the current applet behavior:

- Green below 70%.
- Yellow from 70% through 84%.
- Red from 85% upward.
- Stale, rate-limited, or authentication-required state adds the warning mark
  and uses yellow without discarding the utilization value.

The hover tooltip contains:

```text
Claude
  5h: 35% — resets 23:40
  7d: 62% — resets Tue 08/09 10:00
  Status: current

Codex
  5h: 48% — resets 02:16
  7d: 47% — resets Fri 12/09 00:26
  Plan: Plus
  Status: current

Updated: 22:15
Click to refresh
```

Window labels are derived from duration minutes, so the tooltip remains
correct if a provider changes its quota windows. Error text is concise and
never contains HTTP response bodies, tokens, account IDs, or filesystem
contents.

## Settings

The Cinnamon settings page exposes only settings that are useful on this
machine:

- Polling interval, default 5 minutes.
- Alternate Claude credentials path.
- Codex executable path.
- Codex home path.

Timeouts, thresholds, cache path, and backoff limits remain implementation
constants for this version.

## Installation and rollback

1. Create the symlink into the Cinnamon applet directory.
2. Enable `ai-usage@voccer` alongside `claude-usage@mtwebster` temporarily.
3. Confirm that both Claude and Codex either show fresh values or show the
   correct recoverable state with cached values.
4. Check Cinnamon logs for initialization, JavaScript, HTTP, and subprocess
   errors.
5. Remove only the old UUID from Cinnamon's enabled applet list.

The old applet directory is not deleted. Rollback consists of disabling the
new UUID and re-enabling `claude-usage@mtwebster` in its original panel
position.

## Testing and acceptance criteria

Automated checks:

- Python compilation succeeds for `codex_usage.py`.
- Unit tests cover successful primary/secondary parsing, missing secondary,
  malformed JSONL, app-server error response, missing `codex` bucket, timeout,
  and output redaction.
- JSON metadata and settings schema parse successfully.
- A live adapter probe returns normalized Codex 5-hour and 7-day data without
  tokens or account IDs.
- `cjs` parses the applet entry point without a syntax error, using stubs when
  Cinnamon imports are unavailable outside the shell process.

Runtime acceptance criteria:

- The panel shows one compact item containing Claude and Codex short-window
  values.
- Hovering shows both windows, reset times, freshness, and provider status.
- Clicking refreshes both eligible providers without duplicate requests.
- Simulated 401 retains the Claude value and transitions to
  `auth_required`; replacing the credentials fixture causes automatic
  recovery.
- Simulated 429 retains the Claude value, schedules a retry, and never leaves
  the timer permanently stopped.
- A Codex timeout does not change the Claude state, and a Claude failure does
  not change the Codex state.
- Removing the applet leaves no timers, monitors, or adapter process running.
- Cinnamon logs show no applet initialization or runtime exceptions after the
  old applet is removed from the panel.
