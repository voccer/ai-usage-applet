/* exported retryDelaySeconds, parseRetryAfter, credentialCanRetry,
 * formatDuration, formatClock, usageBar, clickAction, canPoll,
 * panelProviderText, usageColor, tooltipText */

const GLib = imports.gi.GLib;

const BAR_WIDTH = 14;
const BAR_FILL = "\u2588";
const BAR_TRACK = "\u2591";

const COLOR_GOOD = "#8bd450";
const COLOR_WARNING = "#f3c969";
const COLOR_DANGER = "#ff6b6b";
// Secondary text carries no colour of its own: it dims whatever the theme
// already set on #Tooltip. A fixed hex only ever suits one theme's background
// -- #9aa0a6 scores 2.08 contrast on Mint-Y-Dark-Grey but 1.35 on
// Mint-Y-Dark-Aqua, which is unreadable.
const MUTED_ALPHA = "60%";
const TRACK_ALPHA = "28%";

// Inter's default figures are proportional (0 is 1760 units wide, 1 is 1308),
// so the columns only line up with tabular figures enabled. U+2007 FIGURE
// SPACE is exactly one tabular digit wide, which plain U+0020 is not.
const FIGURE_SPACE = "\u2007";

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

function credentialCanRetry(currentFingerprint, rejectedFingerprint) {
    return !rejectedFingerprint || currentFingerprint !== rejectedFingerprint;
}

// A forced refresh may skip our own backoff, but never a Retry-After the
// server issued: retrying inside that window just renews the penalty.
function canPoll(force, nowSeconds, backoffUntil, rateLimitedUntil) {
    if (nowSeconds < rateLimitedUntil) {
        return false;
    }
    if (force) {
        return true;
    }
    return nowSeconds >= backoffUntil;
}

// Right-click stays unhandled so Cinnamon's own panel menu still opens.
function clickAction(button) {
    if (button === 1) {
        return "open";
    }
    if (button === 2) {
        return "refresh";
    }
    return null;
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

function formatClock(timestamp, nowSeconds) {
    if (typeof timestamp !== "number" || !isFinite(timestamp) || timestamp <= 0) {
        return "unknown";
    }

    var reset = GLib.DateTime.new_from_unix_local(Math.round(timestamp));
    var now = typeof nowSeconds === "number" && isFinite(nowSeconds) && nowSeconds > 0
        ? GLib.DateTime.new_from_unix_local(Math.round(nowSeconds))
        : GLib.DateTime.new_now_local();

    if (reset.get_year() === now.get_year() &&
            reset.get_day_of_year() === now.get_day_of_year()) {
        return reset.format("%H:%M");
    }
    return reset.format("%b %-d %H:%M");
}

function usageBar(percent, width) {
    var cells = typeof width === "number" && width > 0 ? Math.round(width) : BAR_WIDTH;
    if (typeof percent !== "number" || !isFinite(percent) || percent <= 0) {
        return _repeat(BAR_TRACK, cells);
    }

    var bounded = Math.max(0, Math.min(100, percent));
    var filled = Math.round(bounded / 100 * cells);
    if (filled === 0) {
        filled = 1;
    }
    if (filled === cells && bounded < 100) {
        filled = cells - 1;
    }
    return _repeat(BAR_FILL, filled) + _repeat(BAR_TRACK, cells - filled);
}

function _repeat(character, count) {
    var text = "";
    for (var index = 0; index < count; index += 1) {
        text += character;
    }
    return text;
}

function _padEnd(text, width) {
    var padded = String(text);
    while (padded.length < width) {
        padded += FIGURE_SPACE;
    }
    return padded;
}

function _padStart(text, width) {
    var padded = String(text);
    while (padded.length < width) {
        padded = FIGURE_SPACE + padded;
    }
    return padded;
}

function _escape(text) {
    return GLib.markup_escape_text(String(text), -1);
}

function _colorize(text, color) {
    return "<span foreground=\"" + color + "\">" + text + "</span>";
}

function _dim(text) {
    return "<span alpha=\"" + MUTED_ALPHA + "\">" + text + "</span>";
}

function _percentColor(percent, status) {
    var className = usageColor(percent, status);
    if (className === "usage-danger") {
        return COLOR_DANGER;
    }
    if (className === "usage-warning") {
        return COLOR_WARNING;
    }
    return COLOR_GOOD;
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

// The track keeps the fill's hue but is dimmed, so a bar reads as one gauge
// rather than two colors competing for attention.
function _barMarkup(percent, color) {
    var bar = usageBar(percent, BAR_WIDTH);
    var trackStart = bar.indexOf(BAR_TRACK);
    if (trackStart === -1) {
        return _colorize(bar, color);
    }

    var markup = "";
    if (trackStart > 0) {
        markup += _colorize(bar.substring(0, trackStart), color);
    }
    markup += "<span foreground=\"" + color + "\" alpha=\"" + TRACK_ALPHA + "\">" +
        bar.substring(trackStart) + "</span>";
    return markup;
}

function _windowLine(window, status, nowSeconds) {
    if (!window || typeof window.usedPercent !== "number") {
        return null;
    }

    var color = _percentColor(window.usedPercent, status);
    var label = _padEnd(formatDuration(window.durationMinutes), 4);
    var bar = _barMarkup(window.usedPercent, color);
    var percent = _colorize(
        _padStart(String(Math.round(window.usedPercent)) + "%", 4),
        color
    );
    var reset = _dim("\u21ba") + " <b>" +
        _escape(formatClock(window.resetsAt, nowSeconds)) + "</b>";
    return FIGURE_SPACE + _escape(label) + FIGURE_SPACE + bar + FIGURE_SPACE +
        percent + FIGURE_SPACE + FIGURE_SPACE + reset;
}

function _providerBlock(name, state, nowSeconds) {
    var heading = "<b>" + _escape(name) + "</b>";
    if (name === "Codex" && state && state.metadata &&
            typeof state.metadata.planType === "string" && state.metadata.planType) {
        heading += "  " + _dim(_escape(state.metadata.planType));
    }

    var lines = [heading];
    var shortLine = _windowLine(state && state.shortWindow, state && state.status, nowSeconds);
    var longLine = _windowLine(state && state.longWindow, state && state.status, nowSeconds);
    if (shortLine) {
        lines.push(shortLine);
    }
    if (longLine) {
        lines.push(longLine);
    }
    if (!shortLine && !longLine) {
        lines.push(FIGURE_SPACE + _dim(_escape("No usage data")));
    }

    var status = state && state.status;
    if (_isDegraded(status)) {
        lines.push(FIGURE_SPACE + _colorize(_escape(_statusText(status)), COLOR_WARNING));
    }
    return lines.join("\n");
}

function _wrap(body) {
    return "<span font_features=\"tnum=1\">" + body + "</span>";
}

function tooltipText(claudeState, codexState, updatedAt, options) {
    var settings = options || {};
    var claudeEnabled = settings.claudeEnabled !== false;
    var codexEnabled = settings.codexEnabled !== false;
    var nowSeconds = typeof settings.nowSeconds === "number" ? settings.nowSeconds : null;

    var blocks = [];
    if (claudeEnabled) {
        blocks.push(_providerBlock("Claude", claudeState, nowSeconds));
    }
    if (codexEnabled) {
        blocks.push(_providerBlock("Codex", codexState, nowSeconds));
    }

    if (blocks.length === 0) {
        return _wrap(_dim(_escape("Both providers are disabled in settings.")));
    }

    var footer = [];
    if (typeof updatedAt === "number" && isFinite(updatedAt) && updatedAt > 0) {
        footer.push("Updated " + formatClock(updatedAt, nowSeconds));
    }
    footer.push("Click a reading to open its app \u00b7 Middle-click to refresh");
    blocks.push(_dim(_escape(footer.join("\n"))));

    return _wrap(blocks.join("\n\n"));
}
