<p><img src="docs/websps-wordmark.svg" alt="Web@SPS" height="56"></p>

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
      "auth": { "user": "api_user", "password_file": "/etc/websps/garden.pw" },
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
      "env": { "WEBSPS_POOL_PW": "change-me" }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `profile` | `read` (default), `operate`, `develop` or `admin` — see [Profiles and tools](#profiles-and-tools) |
| `state_dir` | Directory for logs, recordings, audit log and backups; relative to the config file |
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
| `device_status` | read | Operating status, device info, active rules file, message box |
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
| `rules_activate` | develop | Make a rules file the running program |
| `io_label_set` | develop | Set or delete a channel label |
| `file_write` | develop | Write visualization pages, SVGs and mail templates |
| `file_delete` | develop | Delete a file (backed up first) |
| `device_control` | develop | RUN / STOP the program, request an NTP sync |
| `device_reboot` | develop | REINIT or REBOOT the device |
| `config_set` | admin | Change a configuration field (never passwords) |
| `device_maintenance` | admin | Set the device clock, delete the log file |

Visible tools: `read` 11 · `operate` 13 · `develop` 21 · `admin` 23.

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
3. **Activate.** `rules_activate` sets the root rules file and loads it. If loading fails, the device
   falls back to the file's `.BAK` copy where one exists; if the server switched to a different file,
   it also restores the previous root file. After a failed load the device stays in **STOP** — check
   the result, then resume with `device_control` `RUN`.

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
| `audit.jsonl` | One line per write tool call: time, tool, profile, arguments (without secrets and file contents), outcome |
| `backups/` | Previous content of every overwritten or deleted file, with timestamp |
| `device.lock` | Lock between server processes (removed automatically) |

Nothing is deleted automatically; clean up backups and recordings as needed.

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

## Running from source

```sh
git clone <repository-url> websps-mcp
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
