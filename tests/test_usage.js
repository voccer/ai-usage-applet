#!/usr/bin/cjs

const GLib = imports.gi.GLib;
const Usage = imports.usage;

var failures = 0;

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
var tooltip = Usage.tooltipText(claude, codex, 1788800000);
assertContains(tooltip, "Claude", "tooltip has Claude block");
assertContains(tooltip, "5h: 35%", "tooltip has Claude short window");
assertContains(tooltip, "Codex (plus)", "tooltip has Codex plan");
assertContains(tooltip, "7d: 52%", "tooltip has Codex long window");
assertContains(tooltip, "Rate limited", "tooltip explains degraded status");
assertEqual(tooltip.indexOf("accessToken"), -1, "tooltip omits secret-shaped metadata");
assertEqual(tooltip.indexOf("must-not-appear"), -1, "tooltip omits secret value");

if (failures > 0) {
    throw new Error(failures + " assertion(s) failed");
}

print("All usage helper assertions passed");
