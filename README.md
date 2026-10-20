<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/websps-wordmark-dark.svg">
    <img src="docs/websps-wordmark-light.svg" alt="Web@SPS" height="56">
  </picture>
</p>

# websps-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents read and control **Web@SPS** PLC
devices: read and write channels, record values over time, read logs, and develop and activate rules
programs — with safeguards built for a single-threaded industrial controller.

It works with any MCP client and supports both the current protocol revision (2026-07-28) and older
clients that use the `initialize` handshake.

> **Status:** pre-release. The package is not published yet; until then, run it from source (see
> [Running from source](#running-from-source)).

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Profiles and tools](#profiles-and-tools)
- [Device users and permissions](#device-users-and-permissions)
- [Security](#security)
- [How the server protects the device](#how-the-server-protects-the-device)
- [Working with rules](#working-with-rules)
- [State directory](#state-directory)
- [Errors](#errors)
- [Docker](#docker)
  - [Optional: password in a file](#optional-password-in-a-file-shared-hosts-orchestrators)
- [Running from source](#running-from-source)
- [License](#license)

## Requirements

- Node.js 22 or later
- A Web@SPS device reachable over HTTP from the machine running the server (usually the local network)
- An MCP client that runs local servers over stdio

## Quick start

For one device, environment variables are enough. Add the server to your client's MCP configuration
(the usual `mcpServers` JSON; the file name depends on the client):

```json
{
  "mcpServers": {
    "websps": {
      "command": "npx",
      "args": ["-y", "websps-mcp@0.1.0"],
      "env": {
        "WEBSPS_URL": "http://192.168.2.102",
        "WEBSPS_USER": "api_user",
        "WEBSPS_PASSWORD": "change-me",
        "WEBSPS_PROFILE": "read"
      }
    }
  }
}
```

`192.168.2.102` is the factory default address of a Web@SPS (see the Web@SPS manual); use your
device's address. Always pin the version. `npx` fetches the package on first start, which needs internet access and a
working npm cache.

With Claude Code the same is:

```sh
claude mcp add websps \
  -e WEBSPS_URL=http://192.168.2.102 -e WEBSPS_USER=api_user \
  -e WEBSPS_PASSWORD=change-me -e WEBSPS_PROFILE=read \
  -- npx -y websps-mcp@0.1.0
```

Then ask the agent something like *"What is the status of the device?"* or *"Which outputs are on?"*.

## Configuration

### Several devices: configuration file

Pass a JSON file with `--config <path>` or `WEBSPS_CONFIG`:

```json
{
  "profile": "operate",
  "state_dir": "./state",
  "devices": [
    {
      "alias": "pool",
      "url": "http://192.168.2.102",
      "auth": { "user": "api_user", "password_env": "WEBSPS_POOL_PW" }
    },
    {
      "alias": "garden",
      "url": "http://192.168.2.103",
      "auth": { "user": "api_user", "password_env": "WEBSPS_GARDEN_PW" },
      "timeout_ms": 8000,
      "timeouts_ms": { "io.read_all": 10000 }
    }
  ]
}
```

```json
{
  "mcpServers": {
    "websps": {
      "command": "npx",
      "args": ["-y", "websps-mcp@0.1.0", "--config", "/etc/websps/devices.json"],
      "env": { "WEBSPS_POOL_PW": "change-me", "WEBSPS_GARDEN_PW": "change-me-too" }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `profile` | `read` (default), `operate`, `develop` or `admin` — see [Profiles and tools](#profiles-and-tools) |
| `state_dir` | Directory for logs, recordings, audit log and backups; relative to the config file |
| `retention` | Optional limits for the state directory, see [State directory](#state-directory) |
| `devices[].alias` | Name the agent uses (`device` parameter); 1–32 letters, digits, `_`, `-` |
| `devices[].url` | `http://` address of the device |
| `devices[].auth.user` | Device user name |
| `devices[].auth.password_env` | Name of an environment variable holding the password, **or** |
| `devices[].auth.password_file` | Path of a file holding the password (relative to the config file) |
| `devices[].timeout_ms` | Request timeout, default 5000 |
| `devices[].timeouts_ms` | Per device method, e.g. `{"rules.reload": 15000}`; defaults: `rules.reload` 10000, `logs.search` 45000 |

Passwords are never written into the configuration file itself. Each device may appear only once
(the device locks out the requesting IP after failed logins, regardless of the user).

When more than one device is configured, every tool needs the `device` parameter.

### One device: environment variables

| Variable | Meaning |
|---|---|
| `WEBSPS_URL` | Device address (required) |
| `WEBSPS_USER` | Device user (required) |
| `WEBSPS_PASSWORD` / `WEBSPS_PASSWORD_FILE` | Password or file containing it (exactly one) |
| `WEBSPS_ALIAS` | Alias, default `websps` |
| `WEBSPS_TIMEOUT_MS` | Request timeout, default 5000 |

### Always available

| Variable | Meaning |
|---|---|
| `WEBSPS_PROFILE` | Profile; overrides `profile` from the file |
| `WEBSPS_STATE_DIR` | State directory; overrides `state_dir` |
| `WEBSPS_KEEP_BACKUPS`, `WEBSPS_AUDIT_MAX_MB`, `WEBSPS_RECORDINGS_MAX_DAYS` | Retention limits; override `retention` |
| `WEBSPS_CONFIG` | Configuration file, alternative to `--config` |

Use either a configuration file or `WEBSPS_URL`, not both.

## Profiles and tools

The profile belongs to the server entry in the client configuration, not to the agent: the agent
cannot change it. A client only sees the tools of its profile. Profiles build on each other
(`read` ⊂ `operate` ⊂ `develop` ⊂ `admin`). If one agent should have different rights per device,
add a second server entry with its own profile.

| Tool | Profile | What it does |
|---|---|---|
| `devices_list` | read | Configured devices, reachability, firmware |
| `device_status` | read | Operating status, device info, configured and running rules file, message box |
| `io_read` | read | Channel values with labels, or the complete state of all operands |
| `io_usage` | read | Which channel addresses the active rules use, and which are free |
| `io_labels` | read | Human-readable channel names set on the device |
| `log_read` | read | Console messages (kept beyond the device's 25 lines) or a search of the log file (recent part by default, `full_scan` for all) |
| `sample` | read | Record channel values over time (start, read, stop) |
| `docs_get` | read | Rules operators, rules language, visualization and API docs from the device |
| `file_list` | read | Files of a device directory |
| `file_read` | read | Content of a text file, with its checksum for later writes |
| `config_get` | read | Configuration values, sections or the schema; secrets always masked |
| `io_write` | operate | Set switches, markers and analog setpoints, with optional verification |
| `recording_clear` | operate | Clear a data recorder channel |
| `rules_validate` | develop | Check rules content without writing |
| `rules_write` | develop | Write a rules file (validated, backed up, not activated) |
| `rules_activate` | develop | Make a rules file the running program; replacing the running file needs `expected_root` |
| `io_label_set` | develop | Set or delete a channel label; returns the `previous_label` for undo |
| `io_labels_set` | develop | Set, change or delete many labels in one write of the device's label file; previous values per change |
| `file_write` | develop | Write visualization pages, scripts/SVGs and mail templates (directories as reported by the device) |
| `file_delete` | develop | Delete a file (backed up first) |
| `device_control` | develop | RUN / STOP the program, request an NTP sync |
| `device_reboot` | develop | REINIT or REBOOT the device |
| `config_set` | admin | Change a configuration field (never passwords) |
| `device_maintenance` | admin | Set the device clock, delete the log file |

Visible tools: `read` 11 · `operate` 13 · `develop` 22 · `admin` 24.

Client approval prompts ("allow this tool?") are a convenience, not a protection: users can allow a
tool permanently. What actually limits an agent is the profile and the device user's permissions.

## Device users and permissions

Web@SPS has three independent users besides `admin`: `user1`, `user2` and `api_user`, each with its own
password and permission mask. Give the server a user whose mask matches the profile, so the device
itself refuses what the profile should not do:

| Profile | Mask | Permissions |
|---|---|---|
| `read` | 18925 | read IO, status, info, message box, log, file list/read, config, rules |
| `operate` | 84463 | `read` + write IO, clear data recorder |
| `develop` | 118783 | `operate` + write/delete files, write rules, run/stop/restart |
| `admin` | 122879 | `develop` + write configuration |

Notes:

- No agent profile gets the permissions to read secrets in clear text or to change critical sections
  (network, users, permissions, web server). Passwords and masks are set by a person, on the device.
- The `develop` mask relies on a firmware in which setting channel labels requires the rules-write
  permission. On firmware where it requires the configuration-write permission, use 122879 for
  `develop`; the server then still hides the configuration tools, but the device no longer enforces it.
- With three users, at most three profiles can be set up on one device at the same time.
- Test the masks once per device before production use.

## Security

- **Never make the device reachable from the internet.** It speaks plain HTTP only (no TLS), sends
  credentials in clear text, handles one request at a time and locks out an IP after five failed
  logins — anyone who can reach it could block or overload the plant.
- Put the device into a separate network segment and use passwords that are not used anywhere else.
- The device password is part of the client configuration or environment, as with other MCP servers.
  Where that is not acceptable (shared hosts, orchestrators), use a password file instead — see
  [Optional: password in a file](#optional-password-in-a-file-shared-hosts-orchestrators).
- Only the MCP server talks to the device. In this release the server runs locally (stdio) next to the
  client; it opens no network port itself.
- Secrets from the device configuration are always shown as `***`, even if the device user is allowed
  to read them, and they cannot be set through the server.
- Every change made through the server is recorded in the audit log (see
  [State directory](#state-directory)), in addition to the device's own log.

## How the server protects the device

- **One request at a time** per device, also across several server processes on the same machine
  (each client starts its own process; a lock file in the state directory coordinates them).
- **No login retries.** After a rejected login the server pauses that device for 60 seconds, then tries
  exactly once more. If that fails too, the device stays blocked until the password source changes
  (with `password_file`, fixing the file is enough; with environment variables, restart the server).
  This prevents the server from locking itself out.
- **Busy device:** short automatic retries.
- **Checked before sending:** channel names, writable operand classes (`S`/`M`/`V`/`U` with 0/1,
  `AA`/`SW` with numbers), batch sizes (32), file names and sizes (32767 bytes).
- **Long operations** such as `sample` return an id immediately and are read later, so no request
  blocks a client for long.

## Working with rules

The intended sequence is `rules_validate` → `rules_write` → `rules_activate`:

1. **Validate.** The device checks the syntax, and the server adds its own check for empty parameters
   in the middle of a line (`;;`). The device compiler silently skips those, which shifts all following
   fields — a valid-looking line then does something else.
2. **Write.** `rules_write` always validates first and refuses invalid content. To change an existing
   file, pass `expected_hash` — the `crc16` returned by `file_read`. If the file changed in the meantime
   (e.g. through the web interface), the write is refused. The previous content is saved in the state
   directory; the device itself keeps only one `.BAK` copy. Line endings are converted to CRLF.
   Writing does not activate anything.
3. **Activate.** `rules_activate` sets the root rules file and loads it. Loading a different file than
   the one currently running replaces the program, so it needs `expected_root` with the name of the
   file that runs now (as shown by `device_status`) — like `expected_hash` for writes, a wrong
   assumption about the device then fails before anything changes. Reloading the running file needs
   no confirmation. If loading fails, the device
   falls back to the file's `.BAK` copy where one exists; if the server switched to a different file,
   it also restores the previous root file. After a failed load the device stays in **STOP** — check
   the result, then resume with `device_control` `RUN`. If the device does not answer in time, the
   outcome is unknown and nothing is rolled back: check `device_status` before trying again.

The active root rules file cannot be deleted through the server.

**Plant-specific logic.** How a plant reacts to a switch differs: some use a level (1 = on, 0 = off),
others a pulse on separate on/off channels. The server makes no assumption about this; `io_write` with
`verify` can check that a status channel followed. Describe your plant's conventions to the agent, and
use `io_labels` so it can find channels by name.

**Scheduling.** The server has no scheduler. For time-based switching either use a scheduler in your
client or orchestrator — many chat clients have none — or put the timing into the rules program
(time switch operands), which then runs on the device without any agent.

## State directory

Default: `$XDG_STATE_HOME/websps-mcp` or `~/.local/state/websps-mcp` (on Windows
`%LOCALAPPDATA%\websps-mcp\state`). One subdirectory per device alias:

| Path | Content |
|---|---|
| `console.jsonl` | Console messages collected by `log_read` |
| `samples/<id>.jsonl` | Recordings of `sample`, readable after a server restart |
| `audit.jsonl` | Two lines per write tool call, sharing an `id`: `outcome: "started"` before the operation, then `ok` or `error` with `duration_ms`; each with time, tool, profile and arguments (without secrets and file contents). `ok` lines of some tools add a `result` with what is needed to trace or undo the change: previous label, previous and new root rules file, backup name and checksum of written files, previous configuration value. A `started` line without result marks a call that was interrupted. |
| `backups/` | Previous content of every overwritten or deleted file, with timestamp |
| `device.lock` | Lock between server processes (removed automatically) |

Old data is removed when new data is written (never while reading), with these defaults:

| What | Default | `retention` field | Environment |
|---|---|---|---|
| Backups per device file | newest 20 | `backups_per_file` | `WEBSPS_KEEP_BACKUPS` |
| Audit log | rotated at 10 MB (`audit.jsonl.1` …) | `audit_max_mb` | `WEBSPS_AUDIT_MAX_MB` |
| Rotated audit files | 5 | `audit_files` | – |
| Recordings | older than 30 days removed | `recordings_max_age_days` | `WEBSPS_RECORDINGS_MAX_DAYS` |
| Recordings per device | newest 100 | `recordings_max_count` | – |

A running recording is never removed. `console.jsonl` keeps the latest 5000 lines.

## Errors

Tool errors carry `code`, `name`, `message` and a `hint`. Device errors keep the device's code and its
(German) message:

| Code | Name | Meaning |
|---|---|---|
| 1 | `AUTH` | Login rejected or IP locked out — check user and password |
| 2 | `FORBIDDEN` | Device user lacks the permission, or the object is protected |
| 3 | `PARAMS` | Invalid parameter |
| 4 | `NOT_FOUND` | Key, file or channel does not exist |
| 5 | `BUSY` | Device still busy after retries |
| 6 | `VALIDATION` | Value or request rejected by the device |
| 99 | `INTERNAL` | Internal device error |
| 1001 | `CIRCUIT_OPEN` | Paused after a failed login; retry after the given time |
| 1002 | `AUTH_BLOCKED` | Login keeps failing; fix the credentials |
| 1003 | `UNREACHABLE` | Device not reachable |
| 1004 | `TIMEOUT` | No answer in time |
| 1005 | `BAD_RESPONSE` | Unexpected answer from the device |
| 1006 | `UNKNOWN_DEVICE` | Pass `device` with a configured alias |
| 1007 | `INVALID_INPUT` | Arguments rejected before anything was sent |

Diagnostic messages go to the server's stderr, which most clients show in their MCP log.

If an agent does not seem to know the tools although the server is connected: some clients make a
server's tools visible to the model only after they are enabled individually per agent or session.
Check the client's tool settings; `tools/list` of the server always returns all tools of the profile.

## Docker

The image runs the same stdio server; the MCP client starts a container per session. Until images
are published, build it yourself:

```sh
docker build -t websps-mcp:0.1.0 .
```

Recommended client configuration (`-i` keeps stdin open for the protocol; do not add `-t`):

```json
{
  "mcpServers": {
    "websps": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "64", "--memory", "256m",
        "-e", "WEBSPS_URL", "-e", "WEBSPS_USER", "-e", "WEBSPS_PASSWORD", "-e", "WEBSPS_PROFILE",
        "-v", "websps-state:/state",
        "websps-mcp:0.1.0"
      ],
      "env": {
        "WEBSPS_URL": "http://192.168.2.102",
        "WEBSPS_USER": "api_user",
        "WEBSPS_PASSWORD": "change-me",
        "WEBSPS_PROFILE": "read"
      }
    }
  }
}
```

`-e NAME` without a value passes the variable from the environment of the `docker` call (the `env`
of the client configuration) into the container, so the password is not part of the arguments and
not visible in the process list. Never write `-e WEBSPS_PASSWORD=…` into the arguments.

The server needs no writable file system apart from `/state` and opens no ports, so `--read-only`,
dropping all capabilities and the resource limits do not restrict it.

For several devices, mount the configuration file and pass each device's password variable
(`password_env` in the file) the same way:

```json
"args": [
  "run", "-i", "--rm",
  "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--pids-limit", "64", "--memory", "256m",
  "-e", "WEBSPS_POOL_PW", "-e", "WEBSPS_GARDEN_PW",
  "-v", "/etc/websps:/config:ro",
  "-v", "websps-state:/state",
  "websps-mcp:0.1.0", "--config", "/config/devices.json"
],
"env": { "WEBSPS_POOL_PW": "change-me", "WEBSPS_GARDEN_PW": "change-me-too" }
```

- The state directory inside the container is `/state`. Use a **named volume** (as above), and the
  **same** one for all containers of a device so they share logs and backups and coordinate their
  access to the device. A new named volume takes over the image's permissions, so it works with both
  rootful and rootless Docker.
- If you bind-mount a host directory to `/state` instead: the server runs as `node` (UID 1000 in the
  container), and the directory must be writable for that user. With rootless Docker, container UID
  1000 is a different UID on the host (e.g. 100999, from `/etc/subuid`), so a directory owned by your
  own user is not writable from the container — prefer the named volume.
- Mounted configuration files must be readable for the container user (mode `644` is enough for a
  file without secrets).
- The container must be able to reach the device. The default bridge network usually can; otherwise
  use `--network host` (Linux).
- The container runs as the unprivileged `node` user and opens no ports.

### Optional: password in a file (shared hosts, orchestrators)

Environment values of a container can be read by anyone who may use the Docker daemon
(`docker inspect`). On a single-user host that makes no practical difference; on shared hosts, with
orchestrator secrets, or when client configurations get shared (e.g. in tickets), keep the password
in a file instead. A file also allows changing the password without a restart (see
[How the server protects the device](#how-the-server-protects-the-device)).

Use `WEBSPS_PASSWORD_FILE` instead of `WEBSPS_PASSWORD` (the two exclude each other; in a
configuration file: `password_file` instead of `password_env`) and mount the directory read-only:

```json
"args": [
  "run", "-i", "--rm",
  "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--pids-limit", "64", "--memory", "256m",
  "-e", "WEBSPS_URL", "-e", "WEBSPS_USER", "-e", "WEBSPS_PROFILE",
  "-e", "WEBSPS_PASSWORD_FILE=/config/websps.pw",
  "-v", "/etc/websps:/config:ro",
  "-v", "websps-state:/state",
  "websps-mcp:0.1.0"
]
```

The file holds only the password. It must be readable for the container user (UID 1000) but should
not be readable for others. With rootless Docker, container UID 1000 maps to another host UID, so set
the owner from inside a container (where root is your own host user):

```sh
docker run --rm --user 0 --entrypoint sh -v /etc/websps:/c websps-mcp:0.1.0 \
  -c 'chown -R 1000:1000 /c && chmod 500 /c && chmod 400 /c/websps.pw'
```

Afterwards your host user can no longer read or change the files; to edit them, hand them back first:

```sh
docker run --rm --user 0 --entrypoint sh -v /etc/websps:/c websps-mcp:0.1.0 \
  -c 'chown -R 0:0 /c && chmod 700 /c && chmod 600 /c/websps.pw'
```

With rootful Docker, `chown 1000 /etc/websps/websps.pw` and `chmod 400` on the host do the same.

## Running from source

```sh
git clone https://github.com/wbrangl/websps-mcp.git websps-mcp
cd websps-mcp
npm ci
npm run build
```

Then use `node /path/to/websps-mcp/dist/index.js` as the command in the client configuration instead
of `npx`:

```json
{
  "mcpServers": {
    "websps": {
      "command": "node",
      "args": ["/path/to/websps-mcp/dist/index.js"],
      "env": { "WEBSPS_URL": "http://192.168.2.102", "WEBSPS_USER": "api_user", "WEBSPS_PASSWORD": "change-me" }
    }
  }
}
```

Development: `npm test` runs the test suite against a simulated device (no hardware needed),
`npm run lint` and `npm run typecheck` check the code.

## License

[MIT](LICENSE) © Wolfgang Brangl
