---
name: homeassistant-config
description: Create and manage Home Assistant YAML configuration files including automations, scripts, templates, blueprints, Lovelace dashboards, and file organization. Use when working with Home Assistant configuration files (.yaml, .yml) or discussing HA automations, scripts, sensors, or dashboards.
---

# Home Assistant Configuration Skill

Create and manage Home Assistant YAML configuration files including automations, scripts, templates, blueprints, and file organization.

## Slash Commands

- `/ha-find-duplicates [path]` — Find duplicate automations and scripts in configuration

## Subagents

- `ha-suggestions` — Smart home improvement advisor for automations, scenes, and device recommendations

## Pre-Save Validation Hook

This plugin includes a pre-save hook that automatically validates YAML files before saving. It checks for:
- Tab characters (HA requires spaces)
- Basic YAML syntax errors

The hook runs automatically on Write/Edit operations for `.yaml` and `.yml` files.

## YAML Requirements

- **Indentation**: 2 spaces per level (never tabs)
- **Strings**: Quote boolean-like values (`"on"`, `"off"`, `"yes"`, `"no"`)
- **Lists**: Use `-` prefix with proper indentation
- **Comments**: Use `#` for inline documentation
- **Key Terms**: Use `action:` (not `service:`), `triggers:` (not `trigger:`), `actions:` (not `action:` for sequences)

## File Organization

### Basic Includes

```yaml
# configuration.yaml
automation: !include automations.yaml
script: !include scripts.yaml
sensor: !include sensors.yaml
```

### Directory Includes

```yaml
automation: !include_dir_merge_list automations/
sensor: !include_dir_merge_list sensors/
```

### Secrets Management

```yaml
# secrets.yaml
mqtt_password: "super_secret_password"
api_key: "your-api-key-here"

# configuration.yaml
mqtt:
  password: !secret mqtt_password
```

## Automations (2024+ Syntax)

### Basic Structure

```yaml
automation:
  - alias: "Descriptive Name"
    id: unique_automation_id
    description: "What this automation does"
    mode: single  # single, restart, queued, parallel
    triggers:
      - trigger: state
        entity_id: binary_sensor.motion
        to: "on"
    conditions:
      - condition: time
        after: "sunset"
    actions:
      - action: light.turn_on
        target:
          entity_id: light.living_room
```

### Common Triggers

**State Trigger**
```yaml
triggers:
  - trigger: state
    entity_id: sensor.temperature
    from: "off"
    to: "on"
    for:
      minutes: 5
```

**Time Trigger**
```yaml
triggers:
  - trigger: time
    at: "07:00:00"
```

**Sun Trigger**
```yaml
triggers:
  - trigger: sun
    event: sunset
    offset: "-00:30:00"
```

**Template Trigger**
```yaml
triggers:
  - trigger: template
    value_template: "{{ states('sensor.power') | float > 1000 }}"
```

### Common Actions

**Service Call**
```yaml
actions:
  - action: light.turn_on
    target:
      entity_id: light.bedroom
    data:
      brightness_pct: 50
      color_temp: 350
```

**If-Then-Else**
```yaml
actions:
  - if:
      - condition: state
        entity_id: sun.sun
        state: "below_horizon"
    then:
      - action: light.turn_on
        target:
          entity_id: light.porch
    else:
      - action: light.turn_off
        target:
          entity_id: light.porch
```

**Choose**
```yaml
actions:
  - choose:
      - conditions:
          - condition: state
            entity_id: sun.sun
            state: "below_horizon"
        sequence:
          - action: light.turn_on
            target:
              entity_id: light.porch
    default:
      - action: light.turn_off
        target:
          entity_id: light.porch
```

**Wait for Trigger**
```yaml
actions:
  - action: light.turn_on
    target:
      entity_id: light.porch
  - wait_for_trigger:
      - trigger: state
        entity_id: binary_sensor.motion
        to: "off"
    timeout:
      minutes: 10
    continue_on_timeout: true
  - action: light.turn_off
    target:
      entity_id: light.porch
```

## Scripts

```yaml
script:
  morning_routine:
    alias: "Morning Routine"
    description: "Start the day"
    fields:
      brightness:
        description: "Light brightness"
        default: 100
        selector:
          number:
            min: 0
            max: 100
    sequence:
      - action: light.turn_on
        target:
          area_id: bedroom
        data:
          brightness_pct: "{{ brightness }}"
```

## Jinja2 Templates

```yaml
# Get state
{{ states('sensor.temperature') }}

# Get attribute
{{ state_attr('climate.thermostat', 'current_temperature') }}

# Arithmetic
{{ states('sensor.power') | float * 0.15 | round(2) }}

# Date/time
{{ now().strftime('%H:%M') }}
```

### Template Sensors

```yaml
template:
  - sensor:
      - name: "Total Power Usage"
        unit_of_measurement: "W"
        state: >
          {{ states('sensor.plug_1_power') | float(0) +
             states('sensor.plug_2_power') | float(0) }}
        availability: >
          {{ states('sensor.plug_1_power') not in ['unknown', 'unavailable'] }}
```

## Lovelace Dashboards

### Basic Structure

```yaml
# ui-lovelace.yaml
title: My Home
views:
  - title: Home
    path: home
    icon: mdi:home
    cards:
      - type: entities
        title: Living Room
        entities:
          - light.living_room
          - switch.fan
```

### Common Cards

**Entities Card**
```yaml
type: entities
title: Room Controls
state_color: true
entities:
  - entity: light.ceiling
    name: Ceiling Light
```

**Button Card**
```yaml
type: button
entity: light.bedroom
name: Bedroom
icon: mdi:lightbulb
tap_action:
  action: toggle
```

**Area Card**
```yaml
type: area
area: living_room
display_type: compact
```

**Conditional Card**
```yaml
type: conditional
conditions:
  - condition: state
    entity: person.john
    state: home
card:
  type: entities
  entities:
    - light.johns_room
```

## Blueprints

```yaml
blueprint:
  name: Motion-activated Light
  description: Turn on a light when motion is detected
  domain: automation
  input:
    motion_sensor:
      name: Motion Sensor
      selector:
        entity:
          filter:
            - domain: binary_sensor
              device_class: motion
    target_light:
      name: Light
      selector:
        target:
          entity:
            - domain: light

triggers:
  - trigger: state
    entity_id: !input motion_sensor
    to: "on"

actions:
  - action: light.turn_on
    target: !input target_light
```

## Common Issues

| Problem | Solution |
|---------|----------|
| Tab characters | Replace with 2 spaces |
| Unquoted booleans | Quote `"on"`, `"off"`, `"yes"`, `"no"` |
| Template errors | Test in Developer Tools > Template |
| Entity not found | Check entity_id spelling in Developer Tools > States |
| Automation not firing | Check trace in Automations UI |

## Live HA Access Tools

**One tool: `ha-tools`.** Every command takes `--help` (usage and examples), and
`ha-tools --help` lists them all — the quickest way to check what you have. Flags work in
any position, and `--json` always prints one line, `{"success":…,"command":…,"data":…}`,
where `success` agrees with the exit code. Commands that **change** Home Assistant (`call`,
`fire-event`, `reload`, `lovelace save|create|delete`) are marked `[changes HA]` in the help.

**IMPORTANT — which command for what:**
- **What is it now?** `ha-tools state`, `states-filter "light.*"`, `entities <pattern>`, `template '{{ … }}'`.
- **What happened, and in what order?** `ha-tools timeline <entity> <entity> …` when the question involves **more than one entity** — do not fetch each entity separately and merge by hand. For one entity, `ha-tools history <entity> [hours]`; for long-term statistics, `ha-tools stats`. The window is a trailing hours number, `--hours N`, `--days N` or `--from`/`--to`.
- **Why did an automation or a script do that?** Start small: `ha-tools running` (what is executing now, for how long), `trace-stuck <entity>` (which step an unfinished run waits on), `trace-timeline <entity>` (every step of the newest run, in order), `trace-summary <entity>`. Only reach for `trace` / `trace-latest` — the whole raw trace, which can be very large — when those are not enough. All take `--domain script|automation`, or a qualified id (`script.x`, `automation.x`).
- **Editing an automation:** `ha-tools automation show` for the config HA has loaded, `automation yaml` for its block in `automations.yaml` with line numbers. Then **`ha-tools config-check`** (exits non-zero if invalid) and **`ha-tools reload`**. Never hand-roll a `curl` for either. Both read the Core log across the operation, so they catch the per-entity errors HA only *logs* — a bad option in a `template:` entry means the entity is silently dropped while the config as a whole still "loads". When you have just written a specific entity, prove it: **`ha-tools reload template --expect cover.nick_blind`**.
- **Did my new trigger fire?** `ha-tools trace-watch <entity>` (waits up to 100s; for longer pass `--timeout` and run it in the background). `automation.trigger` skips triggers and conditions, so it proves nothing about the thing you edited.
- **Dashboards:** `ha-tools lovelace` (list / get / save). Lovelace lives only on the WebSocket API — the REST endpoints `/api/lovelace/config` and `/api/lovelace/dashboards` return **404** and must not be used. For **YAML-mode dashboards**, edit the dashboard `.yaml` files directly in `/config`.
- **Logs:** `ha-tools logs` (see below).
- Never ask the user for a long-lived access token — `$SUPERVISOR_TOKEN` is available automatically and is sufficient for everything above.

**Times.** Every ha-tools command prints times in Home Assistant's own timezone
with an explicit offset (`2026-08-12 23:27:42+01:00`). The container clock is
UTC, so do not assume a bare timestamp from anywhere else is local. Pass `--utc`
if you want UTC. Note that other sources still differ: `last_triggered` in raw
state attributes is UTC ISO, `ha-tools history --json` keeps HA's raw epoch
floats inside `data`, and templates using `now()` return local — convert via a ha-tools command
rather than doing the arithmetic yourself.

### ⚠️ Never edit `.storage` or the database directly

**Always ask the user before touching anything under `/config/.storage/` or the
recorder database (`home-assistant_v2.db`).** These hold HA's internal state:
they only load on a full restart (not a reload), bypass HA's validation, and are
trivially corrupted (a piped write that mixes log text into the JSON breaks
them). Prefer service calls, `ha-tools`, and YAML edits, which apply via a
reload:

- Set a helper value with its **service**, not a `.storage` edit:
  - `ha-tools call input_number set_value '{"entity_id":"input_number.x","value":42}'`
  - `ha-tools call input_text set_value '{"entity_id":"input_text.note","value":"hi"}'`
- **Template sensors are read-only and reset to `unknown` on reload** — they
  recompute from other entities, so a "seed then revert" never persists. For a
  user-set persistent value, use an `input_number` / `input_text` helper instead.

### Editing dashboards (ha-tools lovelace)

```bash
# List storage-mode dashboards (empty result → default dashboard is YAML-mode or auto-generated)
ha-tools lovelace list

# Get a dashboard config (omit url_path for the default dashboard)
ha-tools lovelace get
ha-tools lovelace get my-dashboard

# Save a config from a JSON file or stdin (full config object: {"views":[...]})
ha-tools lovelace save /tmp/dash.json
ha-tools lovelace save /tmp/dash.json my-dashboard
echo '{"views":[{"title":"Home","cards":[]}]}' | ha-tools lovelace save -

# Create a NEW storage-mode dashboard (url_path must contain a hyphen), then save its views
ha-tools lovelace create my-room "My Room"                       # options: --icon mdi:sofa --no-sidebar --admin
ha-tools lovelace save /tmp/dash.json my-room                    # new dashboards start empty

# Delete a storage-mode dashboard (resolved by url_path)
ha-tools lovelace delete my-room
```

Workflow for an edit: `ha-tools lovelace get [url_path] > /tmp/dash.json`, modify the JSON, then `ha-tools lovelace save /tmp/dash.json [url_path]`.

Workflow for a new dashboard: `ha-tools lovelace create <url-path> "<Title>"`, then `ha-tools lovelace save <file> <url-path>` to populate its views. The url_path becomes the URL (`/<url-path>`) and must contain a hyphen.

**Mode matters:**
- **Storage mode** → use `ha-tools lovelace get`/`save` as above.
- **YAML mode** → `save` will fail; instead edit the YAML file referenced by `lovelace:` in `/config/configuration.yaml` (commonly `/config/ui-lovelace.yaml` or files under `/config/dashboards/`). The user then reloads dashboard resources or restarts HA.

### ha-tools (WebSocket — preferred for live data)

```bash
# Test connection
ha-tools ping

# Get a single entity state (--json for machine-readable output)
ha-tools state sensor.temperature --json
ha-tools state light.living_room

# Get all states, optionally filtered by pattern
ha-tools states-filter "sensor.*" --json
ha-tools states-filter "light.*"

# Call a service
ha-tools call light turn_on '{"entity_id": "light.living_room", "brightness_pct": 80}'
ha-tools call climate set_temperature '{"entity_id": "climate.thermostat", "temperature": 21}'
ha-tools call input_boolean turn_on '{"entity_id": "input_boolean.guest_mode"}'
ha-tools call input_number set_value '{"entity_id": "input_number.target", "value": 42}'
ha-tools call input_text set_value '{"entity_id": "input_text.note", "value": "hello"}'

# Render a Jinja2 template
ha-tools template '{{ states("sensor.temperature") | float | round(1) }}'
ha-tools template '{{ state_attr("climate.thermostat", "current_temperature") }}'

# History / past data (use these — do NOT build REST history URLs with `date`,
# BusyBox `date` on this Alpine image has no -d/-v flags and will fail)
ha-tools history sensor.temperature       # last 24 hours of state changes
ha-tools history sensor.temperature 6     # last 6 hours
ha-tools logbook                           # recent logbook entries (or: logbook light.hall 6)
# An empty result means the entity simply has no recorded changes in the window.

# history, stats and timeline take the same window however you spell it: a trailing hours number, --hours N, --days N
# (may be a fraction), or --from/--to. Two of the first three is an error.
ha-tools history sensor.temperature --days 7                       # last 7 days
ha-tools history sensor.temperature --from 2026-06-01 --to 2026-06-08 --full
ha-tools stats sensor.energy_cost --days 14                        # last 14 days, hourly
ha-tools stats sensor.energy_cost --from 2026-06-01 --period day   # daily buckets
#   history flags: --hours N | --days N | --from <ISO|YYYY-MM-DD> | --to <ISO> | --full
#   stats   flags: the same window flags | --period 5minute|hour|day|week|month
#   both also take: --format tsv (flat rows in local time) | --json | --utc

# SEVERAL entities on one clock — the main tool for "what happened, in order?".
# Prefer this over calling ha-tools history per entity and merging by hand.
ha-tools timeline light.hall binary_sensor.stairs --days 3
ha-tools timeline light.hall binary_sensor.stairs --days 3 --between 22:00-07:00
ha-tools timeline light.hall --days 1 --format tsv                 # or --json
# Output is one row per event, already merged and sorted, in HA's timezone:
#   08-12 23:27:42  light.hall            on
#   08-12 23:30:17  binary_sensor.stairs  off

# Search entity/device/area registry
ha-tools entities humidity --json
ha-tools devices "phone" --json
ha-tools areas --json

# Fire an event
ha-tools fire-event custom_event '{"key": "value"}'

# Get HA config / list services
ha-tools config --json
ha-tools services --json

# Diagnostics
ha-tools compare sensor.temp_bedroom sensor.temp_living_room
```

Times print in Home Assistant's timezone with an explicit offset; `--utc` opts out.
`--max-items`, `--from`/`--to` and `--show-age` exist only on the commands that act on them —
any other command refuses them rather than ignoring them.

### Traces, scripts and "what is running right now"

```bash
# What is executing right now? Automations AND scripts, longest-running first.
ha-tools running
#   ENTITY                        MODE    RUNS  RUNNING FOR  STARTED   LAST TRIGGERED  EFFECT            LAST STEP
#   script.nick_blind_creep_open  single  1/1   0:42:13      …+01:00   …+01:00         new runs dropped  sequence[1] › parallel branch 1 › sequence[0]
# A `mode: single` script that is still running silently drops every new trigger — that
# is what EFFECT says. RUNNING FOR is "?" when HA stores no running trace for it.

# Which branch is hung, and what is it waiting on?
ha-tools trace-stuck script.nick_blind_creep_open
#   waiting at: sequence[1] › parallel branch 1 › sequence[0]
#     wait_template "{{ is_state('binary_sensor.stairs', 'off') }}" (timeout 00:30:00)
#     here for 0:42:00 — timeout 00:30:00 — template currently renders: false
#   also waiting at: sequence[1] › parallel branch 0 › sequence[0]
#     delay 0:05:00 — remaining: overdue by 0:37:00
# A script that calls another script is followed into the child's run.

# The traces themselves — automations and scripts alike
ha-tools traces script.nick_blind_creep_open          # stored runs, newest first
ha-tools traces --domain script --max-items 10        # every script's recent runs
ha-tools trace-latest script.nick_blind_creep_open    # the newest run, in full (JSON)
ha-tools trace-timeline script.nick_blind_creep_open  # every step in order, with its place in the config
ha-tools trace-actions script.nick_blind_creep_open <run_id>
ha-tools trace-summary automation.hall_light_off      # counts + latest run + what started it
```

`[run_id]` is optional on every per-run command — the newest run is used. Step paths
read like the config: `sequence/1/parallel/0/sequence/2` is the third step of the first
parallel branch of the second step; scripts use `sequence/…` where automations use
`action/…`. `trace-stuck` marks a step `[inferred from last_step]` when the trace records
no result for it yet, rather than claiming it is waiting.

### Editing an automation safely (check → reload → verify)

```bash
# 1. See what HA has loaded right now, and where it lives on disk
ha-tools automation list                                  # entity_id, id, alias, state
ha-tools automation show automation.hall_light_off        # the loaded config
ha-tools automation yaml automation.hall_light_off        # its YAML block, numbered

# 2. Edit the YAML (Edit tool, or Read with offset/limit for a big file)

# 3. Validate BEFORE reloading — exits non-zero if the config is broken.
#    This includes the per-entity errors HA only writes to its log: a bad option
#    in a template/platform entry does NOT stop the config loading, it just
#    silently drops the entity. config-check reports those as platform_errors.
ha-tools config-check

# 4. Reload (no restart needed)
ha-tools reload                    # automations (default)
ha-tools reload script             # or another domain
ha-tools reload all                # everything reloadable
ha-tools reload template --expect cover.nick_blind   # fail if it didn't appear

# 5. Confirm the reload landed, then verify it actually works
ha-tools automation show automation.hall_light_off        # re-read the loaded config
ha-tools trace-watch automation.hall_light_off --timeout 2h
```

`automation show` reports a `schema` field (`plural` / `singular`). Home Assistant
moved from `trigger:`/`condition:`/`action:` to `triggers:`/`conditions:`/`actions:`,
and both spellings are still valid on disk — match whichever the automation
already uses when you edit it.

`trace-watch` **blocks** until the automation next fires, then prints the trace
summary and exits 0; it exits 1 if the timeout passes with no firing. It reports
runs blocked by their conditions too (`script_execution: failed_conditions`),
which is usually the answer you want. Always give it a `--timeout` you're willing
to wait for, and tell the user you're waiting.

### Logs (ha-tools logs) — for "why did X fail?"

**There is no `/config/home-assistant.log`.** HA 2025.11 removed it on HAOS and
Supervised installs and moved Core logging to the systemd journal. The Core REST
endpoint `/api/error_log` was deleted at the same time and now returns **404** —
it is still listed in the HA developer docs, so it looks available and is not.
**Do not try to read either.** Use `ha-tools logs`:

```bash
ha-tools logs                             # last 100 lines of the Core log
ha-tools logs --errors                    # only ERROR/WARNING/CRITICAL/Traceback lines
ha-tools logs --errors -n 1000            # widen the window before filtering
ha-tools logs self -n 200                 # THIS app's own log (the Claude Code UI server)
ha-tools logs supervisor --errors         # Supervisor
ha-tools logs host -n 50                  # host / systemd
ha-tools logs app_core_mosquitto -n 50    # another app's log, by journal identifier
ha-tools logs --units                     # list every identifier you can read
ha-tools logs core --boot 0 --errors      # only since the current boot (--boots lists ids)
ha-tools logs --follow                    # stream live (needs a timeout — it never ends)
```

Notes that matter when reading the output:

- **`-n` is a line budget, not a result count.** It fetches N lines and *then*
  filters, so `--errors -n 100` often returns nothing on a healthy system.
  Reach for `-n 500`/`-n 1000` when hunting a specific failure.
- **Only the Core/host/Supervisor logs are timestamp-first**
  (`2026-08-12 19:36:02.497 WARNING (MainThread) [homeassistant...]`). An *app's*
  log is raw container stdout in whatever format that app uses — this one emits
  `[<ISO8601>] INFO …`. Don't assume a layout when grepping.
- Multi-line tracebacks arrive as separate lines; `--errors` matches the
  `Traceback` line, so widen with `-n` and read the surrounding context.
- `--follow` streams forever — always wrap it: `timeout 30 ha-tools logs --follow`.

For an automation or script that misbehaved, prefer the **trace** (`ha-tools
trace-timeline <entity>`) over the log — it shows the actual step-by-step evaluation. Use logs for integration
errors, startup failures, and anything that never reached a trace.

### REST API via supervisor proxy (curl — use for dashboard editing)

The supervisor proxy at `http://supervisor/core/api/` handles authentication automatically with `$SUPERVISOR_TOKEN`.

```bash
# Get entity state
curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states/sensor.temperature | jq .

# Call a service
curl -s -X POST \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "light.living_room"}' \
  http://supervisor/core/api/services/light/turn_on
```

> Dashboards are **not** available over REST (those endpoints 404). Use `ha-tools lovelace` (see above) or edit YAML files directly.
