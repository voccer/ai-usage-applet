const Applet = imports.ui.applet;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;
const ByteArray = imports.byteArray;
const St = imports.gi.St;
const Settings = imports.ui.settings;

const UUID = "ai-usage@voccer";
const CLAUDE_API_URL = "https://api.anthropic.com/api/oauth/usage";
const STATUS_CLASSES = ["usage-good", "usage-warning", "usage-danger"];

var Usage = null;

function emptyState() {
    return {
        shortWindow: null,
        longWindow: null,
        metadata: {},
        status: "unavailable",
        updatedAt: null
    };
}

function AIUsageApplet(metadata, orientation, panelHeight, instanceId) {
    this._init(metadata, orientation, panelHeight, instanceId);
}

AIUsageApplet.prototype = {
    __proto__: Applet.Applet.prototype,

    _init: function(metadata, orientation, panelHeight, instanceId) {
        Applet.Applet.prototype._init.call(this, orientation, panelHeight, instanceId);

        this.metadata = metadata;
        if (imports.searchPath.indexOf(metadata.path + "/lib") === -1) {
            imports.searchPath.unshift(metadata.path + "/lib");
        }
        Usage = imports.usage;

        this._removed = false;
        this._claudeTimer = 0;
        this._codexTimer = 0;
        this._credentialDebounceTimer = 0;
        this._claudeFailures = 0;
        this._codexFailures = 0;
        this._claudeNextAllowedAt = 0;
        this._codexNextAllowedAt = 0;
        this._claudeRateLimitedUntil = 0;
        this._claudeInFlight = false;
        this._codexInFlight = false;
        this._claudeCancellable = null;
        this._codexCancellable = null;
        this._codexProcess = null;
        this._credentialMonitor = null;
        this._credentialFingerprint = null;
        this._rejectedCredentialFingerprint = null;
        this._lastSuccessfulUpdate = null;
        this._settingsReady = false;
        this.claudeState = emptyState();
        this.codexState = emptyState();

        this._httpSession = new Soup.Session();
        this._buildPanel();
        this._loadCache();
        this._render();

        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        this.settings.bind("enable-claude", "showClaude", this._onProvidersChanged.bind(this));
        this.settings.bind("enable-codex", "showCodex", this._onProvidersChanged.bind(this));
        this.settings.bind("update-interval", "updateInterval", this._onIntervalChanged.bind(this));
        this.settings.bind("claude-credentials-path", "claudeCredentialsPath", this._onClaudePathChanged.bind(this));
        this.settings.bind("codex-executable-path", "codexExecutablePath", this._onCodexPathChanged.bind(this));
        this.settings.bind("codex-home-path", "codexHomePath", this._onCodexPathChanged.bind(this));
        this.settings.bind("claude-desktop-entry", "claudeDesktopEntry");
        this.settings.bind("codex-desktop-entry", "codexDesktopEntry");

        this._settingsReady = true;
        // _buildPanel/_render above ran before these bindings existed, so they
        // assumed both providers were enabled. Re-render now that the real
        // values are known: a disabled provider never polls, and polling is
        // otherwise the only thing that repaints the panel.
        this._render();
        this._setupCredentialMonitor();
        this._scheduleInitialRefresh();
        global.log(UUID + ": initialized");
    },

    _buildPanel: function() {
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this._claude = this._buildReading("Claude");
        this._claudeLabel = this._claude.box;
        this._separatorLabel = new St.Label({
            text: "·",
            style_class: "ai-usage-separator"
        });
        this._codex = this._buildReading("Codex");
        this._codexLabel = this._codex.box;
        this._disabledLabel = new St.Label({
            text: "AI Usage off",
            style_class: "ai-usage-disabled"
        });

        this._makeProviderClickable(this._claudeLabel, "claude");
        this._makeProviderClickable(this._codexLabel, "codex");

        this.actor.add(this._claudeLabel, {y_align: St.Align.MIDDLE, y_fill: false});
        this.actor.add(this._separatorLabel, {y_align: St.Align.MIDDLE, y_fill: false});
        this.actor.add(this._codexLabel, {y_align: St.Align.MIDDLE, y_fill: false});
        this.actor.add(this._disabledLabel, {y_align: St.Align.MIDDLE, y_fill: false});
        this._alignTooltipLeft();
    },

    // A reading is two labels, not one string. Only the name may ellipsize, so
    // its minimum width collapses to nothing while the number keeps its natural
    // width -- a cramped panel then drops "Claude" and still shows "35%". As one
    // label the whole thing ellipsized from the end, losing the number first.
    _buildReading: function(name) {
        var box = new St.BoxLayout({style_class: "ai-usage-provider"});
        var nameLabel = new St.Label({
            text: name,
            style_class: "ai-usage-name"
        });
        var valueLabel = new St.Label({
            text: "--⚠",
            style_class: "ai-usage-value"
        });

        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        valueLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        box.add(nameLabel, {y_align: St.Align.MIDDLE, y_fill: false, expand: true});
        box.add(valueLabel, {y_align: St.Align.MIDDLE, y_fill: false, expand: false});
        return {box: box, name: nameLabel, value: valueLabel};
    },

    // Each reading is its own click target: left-click opens that provider's
    // desktop app, middle-click refreshes just that provider. Right-click is
    // deliberately propagated so Cinnamon's panel menu still works.
    _makeProviderClickable: function(label, provider) {
        label.reactive = true;
        label.track_hover = true;
        label.connect("button-press-event", function(actor, event) {
            var action = Usage.clickAction(event.get_button());
            if (action === "open") {
                this._openDesktopApp(provider);
                return Clutter.EVENT_STOP;
            }
            if (action === "refresh") {
                this._refreshProvider(provider);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }.bind(this));
    },

    _refreshProvider: function(provider) {
        if (provider === "claude") {
            this._pollClaude(false);
        } else {
            this._pollCodex(false);
        }
    },

    _desktopEntryFor: function(provider) {
        return provider === "claude" ? this.claudeDesktopEntry : this.codexDesktopEntry;
    },

    // Launching through the desktop entry rather than a raw command keeps
    // startup notification and single-instance focusing intact.
    _openDesktopApp: function(provider) {
        var entry = this._desktopEntryFor(provider);
        if (!entry) {
            global.logError(UUID + ": no desktop entry configured for " + provider);
            this._refreshProvider(provider);
            return;
        }

        var appInfo = null;
        try {
            appInfo = Gio.DesktopAppInfo.new(entry);
        } catch (error) {
            appInfo = null;
        }
        if (!appInfo) {
            global.logError(UUID + ": desktop entry not found for " + provider);
            this._refreshProvider(provider);
            return;
        }

        try {
            appInfo.launch([], global.create_app_launch_context());
        } catch (error) {
            global.logError(UUID + ": failed to launch the " + provider + " desktop app");
        }
    },

    // Themes commonly center #Tooltip (Mint-Y does), which makes every row of
    // the detail table drift by half the difference in its rendered width.
    // The table only reads correctly left-aligned. The face is set here rather
    // than in stylesheet.css because the tooltip actor is not a child of the
    // applet and so is out of that stylesheet's reach.
    _alignTooltipLeft: function() {
        try {
            var label = this._applet_tooltip && this._applet_tooltip._tooltip;
            if (label) {
                label.set_style("text-align: left; font-family: Inter, sans-serif;");
            }
        } catch (error) {
            global.logError(UUID + ": unable to style the tooltip");
        }
    },

    _claudeEnabled: function() {
        return this.showClaude !== false;
    },

    _codexEnabled: function() {
        return this.showCodex !== false;
    },

    _now: function() {
        return GLib.get_real_time() / 1000000;
    },

    _normalInterval: function() {
        return Math.max(60, Number(this.updateInterval || 5) * 60);
    },

    _expandPath: function(path) {
        if (!path) {
            return path;
        }
        if (path === "~") {
            return GLib.get_home_dir();
        }
        if (path.indexOf("~/") === 0) {
            return GLib.build_filenamev([GLib.get_home_dir(), path.substring(2)]);
        }
        return path;
    },

    _cachePath: function() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), UUID, "state.json"]);
    },

    _sanitizeWindow: function(value) {
        if (!value || typeof value.usedPercent !== "number" ||
                typeof value.durationMinutes !== "number") {
            return null;
        }
        if (!isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100 ||
                !isFinite(value.durationMinutes) || value.durationMinutes <= 0) {
            return null;
        }
        var resetsAt = null;
        if (typeof value.resetsAt === "number" && isFinite(value.resetsAt) && value.resetsAt > 0) {
            resetsAt = Math.round(value.resetsAt);
        }
        return {
            usedPercent: Number(value.usedPercent),
            durationMinutes: Math.round(value.durationMinutes),
            resetsAt: resetsAt
        };
    },

    _stateForCache: function(state, provider) {
        var metadata = {};
        if (provider === "codex" && state.metadata &&
                typeof state.metadata.planType === "string") {
            metadata.planType = state.metadata.planType;
        }
        return {
            shortWindow: this._sanitizeWindow(state.shortWindow),
            longWindow: this._sanitizeWindow(state.longWindow),
            metadata: metadata,
            updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : null
        };
    },

    _loadCache: function() {
        try {
            var result = GLib.file_get_contents(this._cachePath());
            if (!result[0]) {
                return;
            }
            var cache = JSON.parse(ByteArray.toString(result[1]));
            this._restoreCachedProvider("claude", cache.claude);
            this._restoreCachedProvider("codex", cache.codex);
            if (typeof cache.updatedAt === "number") {
                this._lastSuccessfulUpdate = cache.updatedAt;
            }
        } catch (error) {
            global.log(UUID + ": no usable cache");
        }
    },

    _restoreCachedProvider: function(provider, cached) {
        if (!cached) {
            return;
        }
        var shortWindow = this._sanitizeWindow(cached.shortWindow);
        var longWindow = this._sanitizeWindow(cached.longWindow);
        if (!shortWindow && !longWindow) {
            return;
        }
        var state = emptyState();
        state.shortWindow = shortWindow;
        state.longWindow = longWindow;
        state.status = "stale";
        state.updatedAt = typeof cached.updatedAt === "number" ? cached.updatedAt : null;
        if (provider === "codex" && cached.metadata &&
                typeof cached.metadata.planType === "string") {
            state.metadata.planType = cached.metadata.planType;
        }
        this[provider + "State"] = state;
    },

    _saveCache: function() {
        try {
            var cachePath = this._cachePath();
            var cacheDir = GLib.path_get_dirname(cachePath);
            var temporaryPath = cachePath + ".tmp";
            GLib.mkdir_with_parents(cacheDir, 448);
            var payload = JSON.stringify({
                version: 1,
                updatedAt: this._lastSuccessfulUpdate,
                claude: this._stateForCache(this.claudeState, "claude"),
                codex: this._stateForCache(this.codexState, "codex")
            });
            GLib.file_set_contents(temporaryPath, payload);
            GLib.chmod(temporaryPath, 384);
            GLib.rename(temporaryPath, cachePath);
        } catch (error) {
            global.logError(UUID + ": failed to save sanitized cache");
        }
    },

    _setLabelClass: function(reading, className) {
        var labels = [reading.name, reading.value];
        for (var label = 0; label < labels.length; label += 1) {
            for (var index = 0; index < STATUS_CLASSES.length; index += 1) {
                labels[label].remove_style_class_name(STATUS_CLASSES[index]);
            }
            labels[label].add_style_class_name(className);
        }
    },

    _render: function() {
        var claudeEnabled = this._claudeEnabled();
        var codexEnabled = this._codexEnabled();

        this._claudeLabel.visible = claudeEnabled;
        this._codexLabel.visible = codexEnabled;
        this._separatorLabel.visible = claudeEnabled && codexEnabled;
        this._disabledLabel.visible = !claudeEnabled && !codexEnabled;

        var claudeParts = Usage.panelProviderParts("Claude", this.claudeState);
        var codexParts = Usage.panelProviderParts("Codex", this.codexState);
        this._claude.name.set_text(claudeParts.name);
        this._claude.value.set_text(claudeParts.value);
        this._codex.name.set_text(codexParts.name);
        this._codex.value.set_text(codexParts.value);
        this._setLabelClass(this._claude, Usage.usageColor(
            this.claudeState.shortWindow && this.claudeState.shortWindow.usedPercent,
            this.claudeState.status
        ));
        this._setLabelClass(this._codex, Usage.usageColor(
            this.codexState.shortWindow && this.codexState.shortWindow.usedPercent,
            this.codexState.status
        ));
        this.set_applet_tooltip(
            Usage.tooltipText(this.claudeState, this.codexState, this._lastSuccessfulUpdate, {
                claudeEnabled: claudeEnabled,
                codexEnabled: codexEnabled
            }),
            true
        );
    },

    _clearTimer: function(property) {
        if (this[property] > 0) {
            GLib.source_remove(this[property]);
            this[property] = 0;
        }
    },

    _scheduleClaude: function(seconds) {
        this._clearTimer("_claudeTimer");
        if (this._removed) {
            return;
        }
        this._claudeTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(seconds)),
            function() {
                this._claudeTimer = 0;
                this._pollClaude(false);
                return GLib.SOURCE_REMOVE;
            }.bind(this)
        );
    },

    _scheduleCodex: function(seconds) {
        this._clearTimer("_codexTimer");
        if (this._removed) {
            return;
        }
        this._codexTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(seconds)),
            function() {
                this._codexTimer = 0;
                this._pollCodex(false);
                return GLib.SOURCE_REMOVE;
            }.bind(this)
        );
    },

    _scheduleInitialRefresh: function() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, function() {
            if (!this._removed) {
                this._pollClaude(true);
                this._pollCodex(true);
            }
            return GLib.SOURCE_REMOVE;
        }.bind(this));
    },

    _readClaudeCredentials: function() {
        var path = this._expandPath(this.claudeCredentialsPath);
        if (!path) {
            throw new Error("credentials path is empty");
        }
        var result = GLib.file_get_contents(path);
        if (!result[0]) {
            throw new Error("credentials file is unavailable");
        }
        var parsed = JSON.parse(ByteArray.toString(result[1]));
        var oauth = parsed && parsed.claudeAiOauth;
        if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken.trim()) {
            throw new Error("OAuth access token is unavailable");
        }
        return {
            accessToken: oauth.accessToken.trim(),
            expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
            fingerprint: oauth.accessToken + ":" + String(oauth.expiresAt || "")
        };
    },

    _claudeAuthRequired: function() {
        this._claudeInFlight = false;
        this.claudeState.status = "auth_required";
        this._render();
        this._scheduleClaude(60);
    },

    _pollClaude: function(force) {
        if (this._removed || this._claudeInFlight || !this._claudeEnabled()) {
            return;
        }
        var now = this._now();
        if (!Usage.canPoll(force, now, this._claudeNextAllowedAt, this._claudeRateLimitedUntil)) {
            var wait = Math.max(this._claudeNextAllowedAt, this._claudeRateLimitedUntil) - now;
            this._scheduleClaude(Math.max(1, wait));
            return;
        }

        var credentials;
        try {
            credentials = this._readClaudeCredentials();
        } catch (error) {
            this._claudeAuthRequired();
            return;
        }

        if (credentials.fingerprint !== this._credentialFingerprint) {
            this._credentialFingerprint = credentials.fingerprint;
            this._rejectedCredentialFingerprint = null;
            this._claudeFailures = 0;
            this._claudeNextAllowedAt = 0;
        }
        if (credentials.expiresAt && credentials.expiresAt <= GLib.get_real_time() / 1000) {
            this._claudeAuthRequired();
            return;
        }
        if (!Usage.credentialCanRetry(
            credentials.fingerprint,
            this._rejectedCredentialFingerprint
        )) {
            this._claudeAuthRequired();
            return;
        }

        var request = Soup.Message.new("GET", CLAUDE_API_URL);
        request.request_headers.append("Authorization", "Bearer " + credentials.accessToken);
        request.request_headers.append("anthropic-beta", "oauth-2025-04-20");
        request.request_headers.append("Content-Type", "application/json");

        this._claudeInFlight = true;
        this._claudeCancellable = new Gio.Cancellable();
        this._httpSession.send_and_read_async(
            request,
            GLib.PRIORITY_DEFAULT,
            this._claudeCancellable,
            function(session, result) {
                if (this._removed) {
                    return;
                }
                this._claudeInFlight = false;
                this._claudeCancellable = null;
                var bytes;
                try {
                    bytes = session.send_and_read_finish(result);
                } catch (error) {
                    this._handleClaudeUnavailable();
                    return;
                }
                this._handleClaudeResponse(request, bytes);
            }.bind(this)
        );
    },

    _claudeWindow: function(value, durationMinutes) {
        if (!value || typeof value.utilization !== "number" ||
                !isFinite(value.utilization) || value.utilization < 0 || value.utilization > 100) {
            return null;
        }
        var resetsAt = null;
        if (typeof value.resets_at === "string") {
            var reset = GLib.DateTime.new_from_iso8601(value.resets_at, null);
            if (reset) {
                resetsAt = reset.to_unix();
            }
        }
        return {
            usedPercent: value.utilization,
            durationMinutes: durationMinutes,
            resetsAt: resetsAt
        };
    },

    _handleClaudeResponse: function(request, bytes) {
        var status = request.status_code;
        if (status === 200) {
            try {
                var data = JSON.parse(ByteArray.toString(bytes.get_data()));
                var shortWindow = this._claudeWindow(data.five_hour, 300);
                var longWindow = this._claudeWindow(data.seven_day, 10080);
                if (!shortWindow) {
                    throw new Error("primary usage window is missing");
                }
                this.claudeState = {
                    shortWindow: shortWindow,
                    longWindow: longWindow,
                    metadata: {},
                    status: "fresh",
                    updatedAt: this._now()
                };
                this._claudeFailures = 0;
                this._claudeNextAllowedAt = 0;
                this._claudeRateLimitedUntil = 0;
                this._rejectedCredentialFingerprint = null;
                this._lastSuccessfulUpdate = this.claudeState.updatedAt;
                this._saveCache();
                this._render();
                this._scheduleClaude(this._normalInterval());
                return;
            } catch (error) {
                this._handleClaudeUnavailable();
                return;
            }
        }

        if (status === 401) {
            global.log(UUID + ": Claude OAuth sign-in required");
            this._rejectedCredentialFingerprint = this._credentialFingerprint;
            this._claudeAuthRequired();
            return;
        }
        if (status === 429) {
            this._claudeFailures += 1;
            var delay = Usage.parseRetryAfter(
                request.response_headers.get_one("Retry-After"),
                this._now()
            );
            if (delay === null) {
                delay = Usage.retryDelaySeconds(this._claudeFailures);
            }
            this._claudeNextAllowedAt = this._now() + Math.max(1, delay);
            this._claudeRateLimitedUntil = this._claudeNextAllowedAt;
            this.claudeState.status = "rate_limited";
            this._render();
            this._scheduleClaude(delay);
            return;
        }
        if (status >= 500) {
            this._handleClaudeUnavailable();
            return;
        }

        this.claudeState.status = "unavailable";
        this._render();
        this._scheduleClaude(this._normalInterval());
    },

    _handleClaudeUnavailable: function() {
        if (this._removed) {
            return;
        }
        this._claudeInFlight = false;
        this._claudeFailures += 1;
        var delay = Usage.retryDelaySeconds(this._claudeFailures);
        this._claudeNextAllowedAt = this._now() + delay;
        this.claudeState.status = "unavailable";
        this._render();
        this._scheduleClaude(delay);
    },

    _setupCredentialMonitor: function() {
        this._stopCredentialMonitor();
        var credentialPath = this._expandPath(this.claudeCredentialsPath);
        if (!credentialPath) {
            return;
        }
        try {
            var directoryPath = GLib.path_get_dirname(credentialPath);
            var credentialName = GLib.path_get_basename(credentialPath);
            var directory = Gio.File.new_for_path(directoryPath);
            this._credentialMonitor = directory.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._credentialMonitor.connect("changed", function(monitor, file, otherFile) {
                var matches = (file && file.get_basename() === credentialName) ||
                    (otherFile && otherFile.get_basename() === credentialName);
                if (matches) {
                    this._debounceCredentialRefresh();
                }
            }.bind(this));
        } catch (error) {
            global.logError(UUID + ": unable to monitor Claude credentials directory");
        }
    },

    _debounceCredentialRefresh: function() {
        this._clearTimer("_credentialDebounceTimer");
        this._credentialDebounceTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            function() {
                this._credentialDebounceTimer = 0;
                this._pollClaude(true);
                return GLib.SOURCE_REMOVE;
            }.bind(this)
        );
    },

    _stopCredentialMonitor: function() {
        if (this._credentialMonitor) {
            this._credentialMonitor.cancel();
            this._credentialMonitor = null;
        }
    },

    _pollCodex: function(force) {
        if (this._removed || this._codexInFlight || !this._codexEnabled()) {
            return;
        }
        var now = this._now();
        if (!Usage.canPoll(force, now, this._codexNextAllowedAt, 0)) {
            this._scheduleCodex(Math.max(1, this._codexNextAllowedAt - now));
            return;
        }

        var executable = this._expandPath(this.codexExecutablePath);
        var codexHome = this._expandPath(this.codexHomePath);
        var helper = GLib.build_filenamev([this.metadata.path, "codex_usage.py"]);
        try {
            var launcher = Gio.SubprocessLauncher.new(
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            launcher.setenv("CODEX_HOME", codexHome, true);
            this._codexProcess = launcher.spawnv([
                "/usr/bin/python3",
                helper,
                "--codex", executable,
                "--codex-home", codexHome,
                "--timeout", "10"
            ]);
        } catch (error) {
            this._handleCodexUnavailable();
            return;
        }

        this._codexInFlight = true;
        this._codexCancellable = new Gio.Cancellable();
        this._codexProcess.communicate_utf8_async(
            null,
            this._codexCancellable,
            function(process, result) {
                if (this._removed) {
                    return;
                }
                this._codexInFlight = false;
                this._codexCancellable = null;
                this._codexProcess = null;
                var success;
                var stdout;
                try {
                    var completed = process.communicate_utf8_finish(result);
                    success = completed[0];
                    stdout = completed[1];
                } catch (error) {
                    this._handleCodexUnavailable();
                    return;
                }
                if (!success || process.get_exit_status() !== 0) {
                    this._handleCodexUnavailable();
                    return;
                }
                this._handleCodexOutput(stdout);
            }.bind(this)
        );
    },

    _handleCodexOutput: function(stdout) {
        try {
            var data = JSON.parse(stdout);
            if (!data || data.ok !== true || data.provider !== "codex") {
                throw new Error("invalid adapter response");
            }
            var shortWindow = this._sanitizeWindow(data.shortWindow);
            var longWindow = this._sanitizeWindow(data.longWindow);
            if (!shortWindow) {
                throw new Error("primary usage window is missing");
            }
            var metadata = {};
            if (data.metadata && typeof data.metadata.planType === "string") {
                metadata.planType = data.metadata.planType;
            }
            this.codexState = {
                shortWindow: shortWindow,
                longWindow: longWindow,
                metadata: metadata,
                status: "fresh",
                updatedAt: this._now()
            };
            this._codexFailures = 0;
            this._codexNextAllowedAt = 0;
            this._lastSuccessfulUpdate = this.codexState.updatedAt;
            this._saveCache();
            this._render();
            this._scheduleCodex(this._normalInterval());
        } catch (error) {
            this._handleCodexUnavailable();
        }
    },

    _handleCodexUnavailable: function() {
        if (this._removed) {
            return;
        }
        this._codexInFlight = false;
        this._codexProcess = null;
        this._codexFailures += 1;
        var delay = Usage.retryDelaySeconds(this._codexFailures);
        this._codexNextAllowedAt = this._now() + delay;
        this.codexState.status = "unavailable";
        this._render();
        this._scheduleCodex(delay);
    },

    _onProvidersChanged: function() {
        if (!this._settingsReady) {
            return;
        }

        if (this._claudeEnabled()) {
            this._claudeNextAllowedAt = 0;
            this._pollClaude(true);
        } else {
            this._clearTimer("_claudeTimer");
            this._clearTimer("_credentialDebounceTimer");
            this._claudeFailures = 0;
        }

        if (this._codexEnabled()) {
            this._codexNextAllowedAt = 0;
            this._pollCodex(true);
        } else {
            this._clearTimer("_codexTimer");
            this._codexFailures = 0;
        }

        this._render();
    },

    _onIntervalChanged: function() {
        if (!this._settingsReady) {
            return;
        }
        if (this._claudeTimer > 0) {
            this._scheduleClaude(this._normalInterval());
        }
        if (this._codexTimer > 0) {
            this._scheduleCodex(this._normalInterval());
        }
    },

    _onClaudePathChanged: function() {
        if (!this._settingsReady) {
            return;
        }
        this._credentialFingerprint = null;
        this._claudeNextAllowedAt = 0;
        this._setupCredentialMonitor();
        this._pollClaude(true);
    },

    _onCodexPathChanged: function() {
        if (!this._settingsReady) {
            return;
        }
        this._codexNextAllowedAt = 0;
        this._pollCodex(true);
    },

    on_applet_clicked: function() {
        this._pollClaude(false);
        this._pollCodex(false);
    },

    on_applet_removed_from_panel: function() {
        this._removed = true;
        this._clearTimer("_claudeTimer");
        this._clearTimer("_codexTimer");
        this._clearTimer("_credentialDebounceTimer");
        this._stopCredentialMonitor();
        if (this._claudeCancellable) {
            this._claudeCancellable.cancel();
            this._claudeCancellable = null;
        }
        if (this._codexCancellable) {
            this._codexCancellable.cancel();
            this._codexCancellable = null;
        }
        if (this._codexProcess) {
            this._codexProcess.force_exit();
            this._codexProcess = null;
        }
        if (this.settings) {
            this.settings.finalize();
        }
    }
};

function main(metadata, orientation, panelHeight, instanceId) {
    return new AIUsageApplet(metadata, orientation, panelHeight, instanceId);
}
