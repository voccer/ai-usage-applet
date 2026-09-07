# AI Usage Cinnamon Applet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, install, and runtime-verify one Cinnamon panel applet that displays resilient Claude and Codex usage together.

**Architecture:** Fork the installed Claude applet into a new GPL-3.0 project. Keep Cinnamon UI and Claude HTTP handling in `applet.js`, put deterministic formatting/retry logic in a GJS-compatible pure module, and query Codex through a short-lived Python adapter around the documented `codex app-server` JSONL protocol.

**Tech Stack:** Cinnamon 6.6 / CJS, JavaScript, Gio/GLib/Soup, Python 3 standard library, `unittest`, Codex CLI 0.153.4.

**Spec:** `docs/superpowers/specs/2026-09-07-ai-usage-applet-design.md`

## Global Constraints

- Canonical source: `/home/voccer/Desktop/shared/config/cinnamon/ai-usage-applet`.
- Cinnamon UUID: `ai-usage@voccer`.
- Install with a symlink at `~/.local/share/cinnamon/applets/ai-usage@voccer`.
- Preserve GPL-3.0 licensing and attribution to `claude-usage@mtwebster`.
- Panel shows only the short usage window; hover shows all details.
- Keep last successful values visible with `⚠` during degraded states.
- Claude uses its current OAuth access token but the applet never exchanges the refresh token.
- Codex is queried only through `account/rateLimits/read`; the adapter never opens `auth.json`.
- Provider timers, errors, and backoff remain independent.
- Default polling interval is 5 minutes; retry backoff is 1, 2, 4, 8, then 15 minutes.
- Never print tokens, raw credential files, or Codex account IDs.
- Do not remove or delete `claude-usage@mtwebster`; disable it only after runtime acceptance passes.

---

### Task 1: Codex app-server adapter

**Files:**
- Create: `ai-usage@voccer/codex_usage.py`
- Create: `tests/test_codex_usage.py`
- Create: `tests/fixtures/codex-success.jsonl`
- Create: `tests/fixtures/codex-missing-secondary.jsonl`

**Interfaces:**
- Consumes: executable path, Codex home path, and JSONL emitted by `codex app-server`.
- Produces: `parse_rate_limits(lines: Iterable[str]) -> dict`, `query_codex(codex_path: str, codex_home: str, timeout: float = 10.0) -> dict`, and CLI JSON shaped as `{ok, provider, shortWindow, longWindow, metadata}` or `{ok: false, provider, error}`.

- [ ] **Step 1: Write adapter fixtures and failing parser tests**

Use sanitized app-server messages with a `codex` bucket. Tests must assert that
`primary` maps to `shortWindow`, `secondary` maps to `longWindow`, `planType`
maps to `metadata.planType`, and top-level `accountId` never appears in output.

```python
def test_parse_rate_limits_maps_codex_bucket():
    result = parse_rate_limits(SUCCESS_LINES)
    assert result["shortWindow"] == {
        "usedPercent": 48.0,
        "durationMinutes": 300,
        "resetsAt": 1788808614,
    }
    assert result["longWindow"]["durationMinutes"] == 10080
    assert result["metadata"] == {"planType": "plus"}
    assert "accountId" not in json.dumps(result)

def test_parse_rate_limits_accepts_missing_secondary():
    result = parse_rate_limits(MISSING_SECONDARY_LINES)
    assert result["longWindow"] is None
```

- [ ] **Step 2: Run the parser tests and verify failure**

Run: `python3 -m unittest -v tests.test_codex_usage`

Expected: FAIL because `ai-usage@voccer/codex_usage.py` does not exist.

- [ ] **Step 3: Implement strict JSONL parsing and normalization**

Implement `_window(value)` to validate `usedPercent`, `windowDurationMins`, and
`resetsAt`. Scan lines until the response with the request id is found. Reject
an error response, missing result, missing `codex` bucket, or missing primary
window with a short sanitized `AdapterError`.

```python
def parse_rate_limits(lines, request_id=2):
    for line in lines:
        message = json.loads(line)
        if message.get("id") != request_id:
            continue
        if message.get("error"):
            raise AdapterError("Codex app-server returned an error")
        buckets = message.get("result", {}).get("rateLimitsByLimitId", {})
        bucket = buckets.get("codex") or message.get("result", {}).get("rateLimits")
        if not bucket or bucket.get("limitId") != "codex":
            raise AdapterError("Codex usage bucket is unavailable")
        return {
            "ok": True,
            "provider": "codex",
            "shortWindow": _window(bucket.get("primary"), required=True),
            "longWindow": _window(bucket.get("secondary")),
            "metadata": {"planType": bucket.get("planType")},
        }
    raise AdapterError("Codex app-server returned no usage response")
```

- [ ] **Step 4: Add failing subprocess tests**

Mock `subprocess.Popen` to cover a successful response, timeout, executable not
found, malformed JSONL, app-server error, and cleanup. Assert the process is
terminated and only the normalized object reaches stdout.

```python
def test_query_timeout_terminates_child(self):
    process = FakeProcess(timeout=True)
    with patch.object(subprocess, "Popen", return_value=process):
        with self.assertRaisesRegex(AdapterError, "timed out"):
            query_codex("/codex", "/codex-home", timeout=0.01)
    self.assertTrue(process.killed)
```

- [ ] **Step 5: Implement subprocess protocol and CLI**

Start `[codex_path, "app-server"]` with `CODEX_HOME` set in a copied environment.
Write newline-delimited `initialize`, `initialized`, and request-id `2`
messages and flush stdin without closing it. Use `selectors.DefaultSelector`
to read stdout until request id `2` arrives or the deadline expires; Codex may
exit before producing the asynchronous usage response if stdin reaches EOF
immediately. Terminate and reap the process after success, and kill and reap it
on timeout. Parse the captured response and emit one JSON line. CLI failures
return exit 1 with only a sanitized JSON error on stdout.

- [ ] **Step 6: Verify adapter tests and live query**

Run:

```bash
python3 -m unittest -v tests.test_codex_usage
python3 -m py_compile ai-usage@voccer/codex_usage.py
python3 ai-usage@voccer/codex_usage.py \
  --codex /home/voccer/Desktop/shared/config/fnm/aliases/default/bin/codex \
  --codex-home /home/voccer/Desktop/shared/config/codex
```

Expected: all unit tests pass; the live result contains 300- and 10080-minute
windows and contains neither token fields nor `accountId`.

- [ ] **Step 7: Commit the adapter**

```bash
git add ai-usage@voccer/codex_usage.py tests
git commit -m "feat: add Codex usage adapter"
```

### Task 2: Pure display and retry logic

**Files:**
- Create: `ai-usage@voccer/lib/usage.js`
- Create: `tests/test_usage.js`

**Interfaces:**
- Consumes: normalized provider state, current Unix seconds, HTTP status, and optional `Retry-After`.
- Produces: `retryDelaySeconds(failureCount)`, `parseRetryAfter(value, nowSeconds)`, `formatDuration(minutes)`, `formatReset(timestamp)`, `panelProviderText(name, state)`, `usageColor(percent, status)`, and `tooltipText(claudeState, codexState, updatedAt)`.

- [ ] **Step 1: Write failing CJS tests**

```javascript
const Usage = imports.usage;

assertEqual(Usage.retryDelaySeconds(1), 60);
assertEqual(Usage.retryDelaySeconds(5), 900);
assertEqual(Usage.formatDuration(300), "5h");
assertEqual(Usage.formatDuration(10080), "7d");
assertEqual(Usage.panelProviderText("Claude", {
    shortWindow: { usedPercent: 35 }, status: "rate_limited"
}), "Claude 35%⚠");
```

Add cases for percentage rounding, missing data, fresh/stale color selection,
numeric and HTTP-date `Retry-After`, dynamic duration formatting, both tooltip
provider blocks, and absence of secret-shaped fields.

- [ ] **Step 2: Run CJS tests and verify failure**

Run: `cjs -I ai-usage@voccer/lib tests/test_usage.js`

Expected: FAIL because the `usage` module does not exist.

- [ ] **Step 3: Implement minimal pure helpers**

Use ES5-compatible `var` declarations and exported top-level functions so the
module works with Cinnamon's `imports.usage`. Do not import Cinnamon UI APIs.
Use `GLib.DateTime` only for local reset formatting.

- [ ] **Step 4: Run CJS tests and verify success**

Run: `cjs -I ai-usage@voccer/lib tests/test_usage.js`

Expected: all assertions pass and the process exits 0.

- [ ] **Step 5: Commit pure logic**

```bash
git add ai-usage@voccer/lib/usage.js tests/test_usage.js
git commit -m "feat: add usage formatting and retry policy"
```

### Task 3: Cinnamon applet and Claude resilience

**Files:**
- Create: `ai-usage@voccer/applet.js`
- Create: `ai-usage@voccer/metadata.json`
- Create: `ai-usage@voccer/settings-schema.json`
- Create: `ai-usage@voccer/stylesheet.css`
- Create: `ai-usage@voccer/icons/icon-symbolic.svg`
- Create: `tests/test_metadata.py`

**Interfaces:**
- Consumes: `Usage` helpers, Claude OAuth credential JSON, Anthropic usage JSON, and normalized adapter JSON.
- Produces: Cinnamon `main(metadata, orientation, panelHeight, instanceId)` returning an applet with independent Claude and Codex provider states.

- [ ] **Step 1: Add failing metadata/schema tests**

```python
def test_metadata_identity(self):
    metadata = load_json("ai-usage@voccer/metadata.json")
    self.assertEqual(metadata["uuid"], "ai-usage@voccer")

def test_required_settings(self):
    settings = load_json("ai-usage@voccer/settings-schema.json")
    self.assertEqual(settings["update-interval"]["default"], 5)
    self.assertIn("claude-credentials-path", settings)
    self.assertIn("codex-executable-path", settings)
    self.assertIn("codex-home-path", settings)
```

- [ ] **Step 2: Run metadata tests and verify failure**

Run: `python3 -m unittest -v tests.test_metadata`

Expected: FAIL because metadata and settings do not exist.

- [ ] **Step 3: Create metadata, settings, stylesheet, and icon**

Use name `AI Usage`, version `1.0.0`, default update interval `5`, Claude path
`~/.claude/.credentials.json`, stable Codex alias path, and shared Codex home.
Add label classes for green/yellow/red, warning, and provider spacing.

- [ ] **Step 4: Implement provider state and cache handling**

Fork the existing prototype-style Cinnamon applet. Initialize two state
objects, load only normalized fields from `~/.cache/ai-usage@voccer/state.json`,
and atomically save normalized successful state with mode 0600. Render cache
before starting network work.

- [ ] **Step 5: Implement resilient Claude polling**

Before every request, re-read credentials. Check `expiresAt`; expired
credentials transition to `auth_required` without an HTTP call. Monitor the
parent directory and debounce every event whose affected basename matches the
configured credential filename. On changed credentials, clear auth state and
refresh immediately. Expand a leading `~` before constructing `Gio.File`
objects. Pass a provider-specific `Gio.Cancellable` to Soup so removal can
cancel an in-flight request.

Handle responses as follows:

```text
200 -> normalize, save, render, clear backoff
401 -> retain data, auth_required, local credential check every 60 seconds
429 -> retain data, rate_limited, Retry-After or capped backoff
5xx/network -> retain data, unavailable, capped backoff
other 4xx -> retain data, unavailable, normal interval
```

- [ ] **Step 6: Implement asynchronous Codex polling**

Use `Gio.SubprocessLauncher` to set `CODEX_HOME`, execute `/usr/bin/python3`
with `codex_usage.py`, and call `communicate_utf8_async`. Parse only the single
normalized stdout object. Apply success/backoff to Codex state without
touching Claude state. Prevent duplicate in-flight processes and terminate the
child when the applet is removed.

- [ ] **Step 7: Implement panel, tooltip, click, and cleanup**

Render `Claude N% · Codex N%` with short windows only. Append `⚠` for degraded
states while retaining cached values. Build the multiline tooltip from pure
helpers. Click refreshes eligible providers. Removal cancels provider timers,
the directory monitor, Soup work where cancellable, and the adapter process.

- [ ] **Step 8: Run static and unit checks**

Run:

```bash
python3 -m unittest -v
python3 -m py_compile ai-usage@voccer/codex_usage.py
jq empty ai-usage@voccer/metadata.json ai-usage@voccer/settings-schema.json
cjs -I ai-usage@voccer/lib tests/test_usage.js
git diff --check
```

Expected: all tests and parsers pass with no whitespace errors.

- [ ] **Step 9: Commit the applet**

```bash
git add ai-usage@voccer tests/test_metadata.py
git commit -m "feat: build combined AI usage Cinnamon applet"
```

### Task 4: Documentation, installation, and runtime acceptance

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `CHANGELOG.md`
- Modify: Cinnamon enabled applet configuration after validation.

**Interfaces:**
- Consumes: completed `ai-usage@voccer` directory and current Cinnamon panel configuration.
- Produces: installed applet, rollback instructions, and runtime evidence.

- [ ] **Step 1: Write project documentation and attribution**

Document panel/tooltip behavior, OAuth ownership, recovery behavior,
configuration, test commands, installation symlink, log inspection, and
rollback. Include upstream applet name and author in README and use the full
GPL-3.0 license text.

- [ ] **Step 2: Run full pre-install verification**

Run all Task 3 checks plus the live Codex adapter query. Confirm adapter output
contains only normalized usage and plan fields.

- [ ] **Step 3: Create the installation symlink**

Resolve the exact source and target first. Refuse to overwrite a non-symlink
target. Create:

```text
/home/voccer/.local/share/cinnamon/applets/ai-usage@voccer
  -> /home/voccer/Desktop/shared/config/cinnamon/ai-usage-applet/ai-usage@voccer
```

- [ ] **Step 4: Enable the new applet beside the old applet**

Read `org.cinnamon enabled-applets`, append one entry for `ai-usage@voccer`
adjacent to the existing Claude applet, and preserve every other entry and
instance id. Wait for Cinnamon to load the applet and inspect `.xsession-errors`
for the new UUID.

- [ ] **Step 5: Verify live provider behavior**

Confirm the applet initializes without exception, the live Codex adapter
returns both windows, the Claude provider either returns current data or
correctly shows retained data with `auth_required`, hover text contains both
providers, and no long-running `codex app-server` child remains after a poll.

- [ ] **Step 6: Replace the old panel item only after acceptance**

Remove only the `claude-usage@mtwebster` entry from `enabled-applets`, keep its
installed directory untouched, then re-check logs and the enabled list. If the
new applet fails acceptance, remove the new entry and restore the original
list instead.

- [ ] **Step 7: Commit docs and record final evidence**

```bash
git add README.md LICENSE CHANGELOG.md
git commit -m "docs: add AI Usage installation and recovery guide"
git status --short
git log --oneline --decorate -5
```

Expected: working tree clean, old applet files intact, new applet enabled, and
all verification commands green.
