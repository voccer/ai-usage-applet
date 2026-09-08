#!/usr/bin/cjs

const GLib = imports.gi.GLib;
const Usage = imports.usage;

var failures = 0;
var LEGACY_MUTED = "#9aa0a6";
var LEGACY_RESET = "#e6e8ec";

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        printerr("FAIL: " + message + " (expected " + expected + ", got " + actual + ")");
        failures += 1;
    }
}

function assertContains(value, fragment, message) {
    if (value.indexOf(fragment) === -1) {
        printerr("FAIL: " + message + " (missing " + fragment + ")");
        failures += 1;
    }
}

assertEqual(Usage.retryDelaySeconds(1), 60, "first retry is one minute");
assertEqual(Usage.retryDelaySeconds(4), 480, "fourth retry is eight minutes");
assertEqual(Usage.retryDelaySeconds(5), 900, "retry delay caps at fifteen minutes");
assertEqual(Usage.retryDelaySeconds(99), 900, "large retry count stays capped");

assertEqual(Usage.parseRetryAfter("120", 1000), 120, "numeric Retry-After");
var retryDate = new Date((1000 + 180) * 1000).toUTCString();
assertEqual(Usage.parseRetryAfter(retryDate, 1000), 180, "HTTP-date Retry-After");
assertEqual(Usage.parseRetryAfter("not-a-date", 1000), null, "invalid Retry-After");
assertEqual(Usage.credentialCanRetry("token-a", "token-a"), false,
    "a credential rejected by 401 is not retried");
assertEqual(Usage.credentialCanRetry("token-b", "token-a"), true,
    "a changed credential may retry immediately");

assertEqual(Usage.clickAction(1), "open", "left-click opens the provider's app");
assertEqual(Usage.clickAction(2), "refresh", "middle-click refreshes the provider");
assertEqual(Usage.clickAction(3), null, "right-click is left to the panel menu");
assertEqual(Usage.clickAction(8), null, "unknown buttons are ignored");

assertEqual(Usage.canPoll(false, 1000, 0, 0), true, "an idle provider may poll");
assertEqual(Usage.canPoll(false, 1000, 1200, 0), false, "backoff blocks a scheduled poll");
assertEqual(Usage.canPoll(true, 1000, 1200, 0), true, "a forced poll overrides our own backoff");
assertEqual(Usage.canPoll(true, 1000, 0, 1200), false,
    "a forced poll never overrides a server Retry-After");
assertEqual(Usage.canPoll(true, 1300, 0, 1200), true,
    "polling resumes once the Retry-After window passes");

assertEqual(Usage.formatDuration(300), "5h", "five-hour window");
assertEqual(Usage.formatDuration(10080), "7d", "seven-day window");
assertEqual(Usage.formatDuration(90), "1h 30m", "mixed duration");
assertEqual(Usage.formatDuration(45), "45m", "minute duration");

assertEqual(Usage.panelProviderText("Claude", {
    shortWindow: {usedPercent: 34.6},
    status: "fresh"
}), "Claude 35%", "percentage is rounded");
assertEqual(Usage.panelProviderText("Claude", {
    shortWindow: {usedPercent: 35},
    status: "rate_limited"
}), "Claude 35%⚠", "degraded data stays visible");
assertEqual(Usage.panelProviderText("Codex", {
    shortWindow: null,
    status: "unavailable"
}), "Codex --⚠", "missing degraded data is explicit");

assertEqual(Usage.usageColor(69.9, "fresh"), "usage-good", "low usage is green");
assertEqual(Usage.usageColor(70, "fresh"), "usage-warning", "medium usage is yellow");
assertEqual(Usage.usageColor(85, "fresh"), "usage-danger", "high usage is red");
assertEqual(Usage.usageColor(10, "rate_limited"), "usage-warning", "degraded state is yellow");

var claude = {
    shortWindow: {usedPercent: 35, durationMinutes: 300, resetsAt: 1788808614},
    longWindow: {usedPercent: 20, durationMinutes: 10080, resetsAt: 1789232801},
    status: "fresh",
    metadata: {}
};
var codex = {
    shortWindow: {usedPercent: 74, durationMinutes: 300, resetsAt: 1788808614},
    longWindow: {usedPercent: 52, durationMinutes: 10080, resetsAt: 1789232801},
    status: "rate_limited",
    metadata: {planType: "plus", accessToken: "must-not-appear"}
};
assertEqual(Usage.usageBar(0, 10), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591",
    "an empty bar is all track");
assertEqual(Usage.usageBar(100, 10), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588",
    "a full bar is all fill");
assertEqual(Usage.usageBar(50, 10), "\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591",
    "half usage fills half the bar");
assertEqual(Usage.usageBar(1, 10), "\u2588\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591",
    "a nonzero percentage always shows one cell");
assertEqual(Usage.usageBar(99, 10), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591",
    "an incomplete window never looks full");
assertEqual(Usage.usageBar(null, 10).length, 10, "a missing percentage still occupies the column");

var noonToday = 1788756800; // 2026-09-07 11:53 local, safely mid-day
assertEqual(Usage.formatClock(noonToday + 3600, noonToday).indexOf(" "), -1,
    "a reset later today shows only a clock time");
assertContains(Usage.formatClock(noonToday + 4 * 86400, noonToday), " ",
    "a reset on another day shows its date");
assertEqual(Usage.formatClock(0, noonToday), "unknown", "a missing reset is explicit");

var tooltip = Usage.tooltipText(claude, codex, 1788800000);
assertContains(tooltip, "<b>Claude</b>", "tooltip has a Claude heading");
assertContains(tooltip, "<b>Codex</b>", "tooltip has a Codex heading");
assertContains(tooltip, "plus", "tooltip has the Codex plan");
assertContains(tooltip, "35%", "tooltip has the Claude short window");
assertContains(tooltip, "52%", "tooltip has the Codex long window");
assertContains(tooltip, "Rate limited", "tooltip explains degraded status");
assertEqual(tooltip.indexOf("Current"), -1,
    "a healthy provider shows no status line, only degraded ones do");
assertEqual(tooltip.indexOf(LEGACY_MUTED), -1,
    "secondary text no longer hardcodes a colour for one theme");
assertEqual(tooltip.indexOf(LEGACY_RESET), -1,
    "reset times no longer hardcode a colour for one theme");
assertContains(tooltip, "alpha=\"60%\"",
    "secondary text dims the theme's own tooltip colour instead");
assertContains(tooltip, "\u2588", "tooltip draws usage bars");
assertContains(tooltip, "alpha=", "the unused part of a bar is dimmed");
assertContains(tooltip, "Middle-click", "tooltip documents how to refresh");
assertContains(tooltip, "font_features", "tooltip requests tabular figures");
assertEqual(tooltip.indexOf("<tt>"), -1, "tooltip no longer forces a monospace face");
assertContains(tooltip, "\u2007",
    "columns are padded with figure spaces, which match a tabular digit");
assertEqual(tooltip.indexOf("accessToken"), -1, "tooltip omits secret-shaped metadata");
assertEqual(tooltip.indexOf("must-not-appear"), -1, "tooltip omits secret value");

var escaped = Usage.tooltipText(claude, {
    shortWindow: {usedPercent: 10, durationMinutes: 300, resetsAt: 1788808614},
    longWindow: null,
    status: "fresh",
    metadata: {planType: "pro & <team>"}
}, 1788800000);
assertEqual(escaped.indexOf("<team>"), -1, "provider metadata is markup-escaped");
assertContains(escaped, "&lt;team&gt;", "escaped metadata is still readable");

var claudeOnly = Usage.tooltipText(claude, codex, 1788800000,
    {claudeEnabled: true, codexEnabled: false});
assertContains(claudeOnly, "<b>Claude</b>", "a disabled provider keeps the enabled one");
assertEqual(claudeOnly.indexOf("<b>Codex</b>"), -1, "a disabled provider is omitted");

var codexOnly = Usage.tooltipText(claude, codex, 1788800000,
    {claudeEnabled: false, codexEnabled: true});
assertContains(codexOnly, "<b>Codex</b>", "Codex can be shown alone");
assertEqual(codexOnly.indexOf("<b>Claude</b>"), -1, "Claude is omitted when disabled");

var noneEnabled = Usage.tooltipText(claude, codex, 1788800000,
    {claudeEnabled: false, codexEnabled: false});
assertContains(noneEnabled, "disabled", "disabling both providers is explained");

if (failures > 0) {
    throw new Error(failures + " assertion(s) failed");
}

print("All usage helper assertions passed");
