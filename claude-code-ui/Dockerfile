ARG BUILD_FROM
FROM ${BUILD_FROM}

ARG BUILD_ARCH

# Install system packages (no build tools — all binaries are pre-compiled).
# Debian base (bookworm): needed so the ESPHome/PlatformIO toolchains, which are
# glibc binaries, can run when the optional `enable_esphome` capability is used.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        nano \
        nodejs \
        npm \
        python3 \
        python3-pip \
        python3-venv \
        python3-yaml \
        tree \
    && rm -rf /var/lib/apt/lists/*

# uv — used to provision a standalone Python 3.12 for the optional ESPHome venv
# (Debian bookworm ships 3.11, but ESPHome needs >=3.12) and by the debug
# /diag/uvx endpoint. Debian has no `uv` apt package; install the wheel.
RUN pip3 install --no-cache-dir --break-system-packages uv

# Install server Node.js dependencies (includes Agent SDK with bundled CLI binary)
COPY server/package.json /opt/server/package.json
RUN cd /opt/server && npm install --omit=dev

# Ensure the correct glibc platform binary is installed for the target arch.
# (Debian is glibc; the musl variants would not run here.)
RUN case "${BUILD_ARCH}" in \
    aarch64) SDK_PKG="@anthropic-ai/claude-agent-sdk-linux-arm64" ;; \
    amd64)   SDK_PKG="@anthropic-ai/claude-agent-sdk-linux-x64" ;; \
    *) echo "ERROR: Unsupported arch ${BUILD_ARCH}" && exit 1 ;; \
    esac \
    && SDK_VER=$(node -e "console.log(require('/opt/server/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version)") \
    && npm install --prefix /opt/server --no-save "${SDK_PKG}@${SDK_VER}" \
    && npm cache clean --force

# Expose the Agent SDK's bundled Claude binary as the system `claude` command.
# This gives terminal access without duplicating the ~240MB binary.
RUN case "${BUILD_ARCH}" in \
    aarch64) SDK_BIN="/opt/server/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude" ;; \
    amd64)   SDK_BIN="/opt/server/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude" ;; \
    esac \
    && ln -sf "$SDK_BIN" /usr/local/bin/claude

RUN mkdir -p /config/claude-config
WORKDIR /config

# Copy application files
# (bump SCRIPTS_VER to force Docker layer re-copy on next build)
ARG SCRIPTS_VER=31
COPY server/index.js /opt/server/index.js
COPY server/lib/ /opt/server/lib/
COPY frontend/ /opt/frontend/
COPY plugins/ /opt/plugins/
COPY scripts/ /opt/scripts/
COPY run.sh /run.sh

RUN chmod +x /run.sh \
    && chmod +x /opt/scripts/*.sh \
    && chmod +x /opt/plugins/homeassistant-config/hooks/*.sh

# `ha-tools` — the one entry point for this app's HA helpers: states, services,
# registries, history, automation and script traces, dashboards (Node, over the
# WebSocket API) and logs (Supervisor journald — needed because HA 2025.11 removed
# /config/home-assistant.log and the Core `/api/error_log` endpoint). One name:
# the old third-party ha-ws-client binary and the ha-history / ha-stats / … shortcuts
# are gone, so there is nothing for the dispatcher to read from argv[0].
RUN ln -sf /opt/scripts/ha-tools.sh /usr/local/bin/ha-tools

# `claude-tasks` — drives the chat UI's task-list widget (see
# server/lib/tasks.js and plugins/productivity-tools). A plain Node CLI, no
# symlink dance needed for arch-specific modules the way ha-tools has.
RUN ln -sf /opt/scripts/claude-tasks.sh /usr/local/bin/claude-tasks \
    && chmod +x /opt/scripts/claude-tasks.sh /opt/scripts/claude-tasks.cjs

# `team-notes` — logs a dated note on a Team-panel member (see
# server/lib/team.js and plugins/productivity-tools). Same shape as
# claude-tasks above.
RUN ln -sf /opt/scripts/team-notes.sh /usr/local/bin/team-notes \
    && chmod +x /opt/scripts/team-notes.sh /opt/scripts/team-notes.cjs

# `esphome` command — thin wrapper over the venv the app installs into /data
# on first enable (optional ESPHome capability). Present even when disabled so an
# attempt gives a helpful message rather than "command not found". Points the
# PlatformIO compiler cache at /data so it persists across restarts.
RUN printf '%s\n' \
    '#!/bin/bash' \
    'ESPHOME_BIN=/data/esphome/venv/bin/esphome' \
    'if [ -x "$ESPHOME_BIN" ]; then' \
    '  export PLATFORMIO_CORE_DIR="${PLATFORMIO_CORE_DIR:-/data/esphome/.platformio}"' \
    '  # Run compiles at idle CPU/IO priority so a build can never starve PID 1 /' \
    '  # the host watchdog or contend with a backup. ionice is optional (util-linux).' \
    '  NICE="nice -n 19"' \
    '  command -v ionice >/dev/null 2>&1 && NICE="$NICE ionice -c 3"' \
    '  exec $NICE "$ESPHOME_BIN" "$@"' \
    'fi' \
    'echo "ESPHome is not installed. Turn on \"enable_esphome\" in the app options;" >&2' \
    'echo "first-time setup installs it in the background (a few minutes) — watch the app log." >&2' \
    'exit 1' \
    > /usr/local/bin/esphome \
    && chmod +x /usr/local/bin/esphome

# Bypass s6-overlay — HA Supervisor runs containers with --init (tini as PID 1),
# which prevents s6-overlay-suexec from running as PID 1.
ENTRYPOINT ["/bin/bash", "/run.sh"]
