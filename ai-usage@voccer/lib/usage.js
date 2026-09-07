/* exported retryDelaySeconds, parseRetryAfter, formatDuration, formatReset,
 * panelProviderText, usageColor, tooltipText */

const GLib = imports.gi.GLib;

function retryDelaySeconds(failureCount) {
    var schedule = [60, 120, 240, 480, 900];
    var index = Math.max(0, Math.min(schedule.length - 1, failureCount - 1));
    return schedule[index];
}

function parseRetryAfter(value, nowSeconds) {
    if (value === null || value === undefined) {
        return null;
    }

    var text = String(value).trim();
    if (/^\d+$/.test(text)) {
        return Math.max(0, parseInt(text, 10));
    }

    var parsedMilliseconds = Date.parse(text);
    if (isNaN(parsedMilliseconds)) {
        return null;
    }

    return Math.max(0, Math.ceil(parsedMilliseconds / 1000 - nowSeconds));
}

function formatDuration(minutes) {
    if (typeof minutes !== "number" || !isFinite(minutes) || minutes <= 0) {
        return "--";
    }

    var rounded = Math.round(minutes);
    if (rounded % 1440 === 0) {
        return String(rounded / 1440) + "d";
    }
    if (rounded % 60 === 0) {
        return String(rounded / 60) + "h";
    }
    if (rounded > 60) {
        return String(Math.floor(rounded / 60)) + "h " + String(rounded % 60) + "m";
    }
    return String(rounded) + "m";
}

function formatReset(timestamp) {
    if (typeof timestamp !== "number" || !isFinite(timestamp) || timestamp <= 0) {
        return "unknown";
    }

    var dateTime = GLib.DateTime.new_from_unix_local(Math.round(timestamp));
    return dateTime.format("%Y-%m-%d %H:%M");
}

function _isDegraded(status) {
    return status !== "fresh";
}

function panelProviderText(name, state) {
    var text = name + " --";
    if (state && state.shortWindow && typeof state.shortWindow.usedPercent === "number") {
        text = name + " " + String(Math.round(state.shortWindow.usedPercent)) + "%";
    }
    if (!state || _isDegraded(state.status)) {
        text += "⚠";
    }
    return text;
}

function usageColor(percent, status) {
    if (_isDegraded(status)) {
        return "usage-warning";
    }
    if (typeof percent !== "number" || !isFinite(percent)) {
        return "usage-warning";
    }
    if (percent >= 85) {
        return "usage-danger";
    }
    if (percent >= 70) {
        return "usage-warning";
    }
    return "usage-good";
}

function _statusText(status) {
    var labels = {
        fresh: "Current",
        stale: "Cached",
        auth_required: "Sign in required",
        rate_limited: "Rate limited",
        unavailable: "Temporarily unavailable"
    };
    return labels[status] || "Waiting for data";
}

function _windowLine(window) {
    if (!window || typeof window.usedPercent !== "number") {
        return null;
    }
    return formatDuration(window.durationMinutes) + ": " +
        String(Math.round(window.usedPercent)) + "% · resets " +
        formatReset(window.resetsAt);
}

function _providerBlock(name, state) {
    var title = name;
    if (name === "Codex" && state && state.metadata &&
            typeof state.metadata.planType === "string" && state.metadata.planType) {
        title += " (" + state.metadata.planType + ")";
    }

    var lines = [title];
    var shortLine = _windowLine(state && state.shortWindow);
    var longLine = _windowLine(state && state.longWindow);
    if (shortLine) {
        lines.push(shortLine);
    }
    if (longLine) {
        lines.push(longLine);
    }
    if (!shortLine && !longLine) {
        lines.push("No usage data");
    }
    lines.push("Status: " + _statusText(state && state.status));
    return lines.join("\n");
}

function tooltipText(claudeState, codexState, updatedAt) {
    var blocks = [
        _providerBlock("Claude", claudeState),
        _providerBlock("Codex", codexState)
    ];
    if (typeof updatedAt === "number" && isFinite(updatedAt) && updatedAt > 0) {
        blocks.push("Last successful update: " + formatReset(updatedAt));
    }
    return blocks.join("\n\n");
}
