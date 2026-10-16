# pi-http

**English** | [简体中文](README.zh-CN.md)

[GitHub repository](https://github.com/wwyy456258/pi-http) | [Report an issue](https://github.com/wwyy456258/pi-http/issues)

A Pi extension that exposes AI and tool execution over HTTP from within the Pi process. It supports multi-turn chats, optional file attachments, and model selection.

The initial API has two endpoints:

- `POST /v1/chat`: start or continue a chat, optionally uploading files with the request.
- `GET /v1/models`: list available models and the current default model.

Chat requests wait for execution to finish and return JSON. SSE is not used. Initialization generates an API key in a private `environment.json` file; `PI_HTTP_API_KEY` can override it. Clients authenticate with `Authorization: Bearer <API Key>`.

HTTP requests have the same permissions as running Pi directly. The extension adds no restrictions on tools, file access, or network access.

See the [design document (Chinese)](docs/design.md) for the API contract, authentication, file storage, chat expiration, and error handling. Pi loads the extension, and HTTP chats use separate internal Pi sessions without adding messages to the foreground conversation.

## Installation and first-time configuration

Requires Node.js 22.19 or newer and an installed Pi CLI. Tested with Pi 1.3.0. Configure your models and provider credentials in Pi first.

```bash
npm ci --ignore-scripts
pi install /absolute/path/to/pi-http
```

**Installation only registers the extension with Pi. It does not start HTTP or write machine configuration. Before starting HTTP for the first time, initialize the configuration, edit it, and then start the listener.** Upgrades preserve existing configuration.

In an interactive Pi session, run:

```text
/http init
/http config
/http start
/http status
/http stop
```

By default, `/http init` creates configuration, environment, and data directories under `/data/pi-http`, and generates an HTTP API key or reuses an exported key. Existing configuration and keys are preserved. Edit the main configuration file below before running `/http start`.

| Purpose | Default location |
| --- | --- |
| Main HTTP configuration | `/data/pi-http/config/pi-http.config.json` |
| HTTP key and background environment variables | `/data/pi-http/config/environment.json` |
| Background service configuration and status | `/data/pi-http/config/service.json`, `status.json` |
| Chat attachments | `/data/pi-http/chats/` |
| State database | `/data/pi-http/pi-http.sqlite` |
| HTTP request logs | `/data/pi-http/logs/http.jsonl` |
| macOS background launcher logs | `/data/pi-http/logs/service.log` |

Missing directories are created recursively. New directories use permissions `0700`; configuration, key, and log files use `0600`. If your user cannot create `/data/pi-http`, the error identifies the failed path. Have an administrator create the directory and grant access, or choose a location your user can write to:

```text
/http init /absolute/writable/path/pi-http
```

The command prints the configuration and environment file paths, without printing the key. Subsequent `/http start` commands in the current Pi instance use this configuration. On your next Pi startup, pass the printed path with `--http-config`.

You can also initialize from a terminal before entering Pi:

```bash
SERVICE=/absolute/path/to/pi-http/scripts/service.mjs
node "$SERVICE" init
# Use a custom data root:
node "$SERVICE" init --data-dir /absolute/writable/path/pi-http
# Choose the main configuration file location:
node "$SERVICE" init --data-dir /absolute/writable/path/pi-http \
  --http-config /absolute/path/to/pi-http.config.json
```

### Directories and models

See `pi-http.config.example.json` for an example. Changing only `paths.data_dir` also changes paths that have not been explicitly overridden. These fields can override individual directories or files:

| Configuration field | Default when omitted |
| --- | --- |
| `paths.data_dir` | `/data/pi-http` |
| `paths.config_dir` | `<data_dir>/config`, for the environment, background service configuration, and status |
| `logging.directory` | `<data_dir>/logs` |
| `chat.storage_dir` | `<data_dir>/chats` |
| `storage.database_path` | `<data_dir>/pi-http.sqlite` |

Explicit relative paths resolve from the directory containing the main configuration file. The main file itself is selected with `--http-config`; setting `paths.config_dir` inside it does not relocate that file. Changing paths does not migrate existing databases, attachments, or environment files. Migrate them yourself or keep explicit paths to their original locations.

Configuration lookup order: `--http-config <path>` → an existing `pi-http.config.json` in Pi's working directory, for compatibility with older deployments → `/data/pi-http/config/pi-http.config.json`. `/http config` shows the selected file and resolved directories without displaying the key.

```bash
pi --http --http-config /absolute/path/to/pi-http.config.json
```

The default listener is `127.0.0.1:3000`. For LAN access, set `server.host` to the appropriate interface address or `0.0.0.0`, and set `server.port`. Model selection follows this order: request `model` → configuration `model.default` → the host Pi session's current default model. Query `/v1/models` for available models.

After editing configuration, run `/http stop` followed by `/http start`. With `--http`, the listener starts automatically when a Pi session starts or finishes reloading. Exiting Pi or switching sessions closes the current listener. HTTP chats use their own internal Pi sessions and do not add messages to the foreground conversation.

### Finding and changing the API key

The generated or reused HTTP API key is the `PI_HTTP_API_KEY` field in `environment.json`. Give this key to your clients and use `Authorization: Bearer <Key>`. You can also generate a key with `openssl rand -hex 32` and replace that field.

For the curl examples below, first set `export PI_HTTP_API_KEY='<Key from the environment file>'`.

The foreground extension first checks `PI_HTTP_API_KEY` in the Pi process environment. If it is unset, it reads `paths.config_dir/environment.json`. Pi continues to manage model provider credentials itself. Keep the HTTP key out of business configuration, the repository, and request logs.

Changing a key supplied through the process environment requires restarting Pi. When using the environment file, restart the foreground HTTP listener with `/http stop` and `/http start`, or run `restart` for a background service. A key already set in the process environment takes precedence over the same field in the file.

## HTTP request logs

File logging is enabled by default. Both interactive and background Pi write one JSON object per line to `logging.directory/http.jsonl`:

- `request_received`: UTC timestamp, request ID, HTTP method, path, and source IP.
- `request_input`: JSON input after authentication and format validation, recorded before model execution.
- `response_sent`: UTC timestamp, the same request ID, status code, duration in milliseconds, input and output, response bytes, file count, individual file sizes, and total file bytes.
- `request_aborted`: client disconnect, including file bytes received so far; the logged status is `499`.

Authentication failures, invalid requests, and upstream errors are logged too. Unauthenticated requests do not have their business input logged. Attachments are represented only by counts and sizes, without filenames, paths, content, or binary data. Request headers and URL query parameters are excluded. Known credentials and Bearer tokens are redacted while useful error details are retained.

Chat input and replies are logged by default. Set `logging.log_bodies: false` to log metadata only. `logging.max_body_chars` defaults to `16384`; longer values are replaced with a preview marked `truncated`. Logs rotate at `logging.max_file_bytes`, which defaults to 10 MiB, with up to `logging.max_files` archives, defaulting to 7. Archives are named `http.jsonl.1`, and so on. A single record is never split across files.

```bash
tail -n 100 -F /data/pi-http/logs/http.jsonl
```

HTTP startup fails if the log directory cannot be created or the log file cannot be opened. Write failures during operation are reported to stderr with the time and path, while business requests can continue. Chat TTL controls chat cleanup, not log retention.

## Background operation and automatic restarts

Linux uses a systemd user service; macOS uses a launchd LaunchAgent. The launcher runs the real Pi CLI in RPC mode, loads this extension, keeps the input pipe open, waits for HTTP readiness, and forwards shutdown signals. The operating system manages restarts after failures.

Initialize and edit the configuration, and complete model setup and any required project trust authorization in the target Pi working directory before installing the service:

```bash
SERVICE=/absolute/path/to/pi-http/scripts/service.mjs
node "$SERVICE" init
# Edit /data/pi-http/config/pi-http.config.json before installing:
node "$SERVICE" install --cwd /absolute/path/to/workspace --pi "$(command -v pi)"
node "$SERVICE" start
node "$SERVICE" status
node "$SERVICE" logs
```

When using a custom main configuration file, pass the same path during installation and subsequent management:

```bash
node "$SERVICE" install --http-config /absolute/path/to/pi-http.config.json \
  --cwd /absolute/path/to/workspace --pi "$(command -v pi)"
node "$SERVICE" start --http-config /absolute/path/to/pi-http.config.json
node "$SERVICE" stop --http-config /absolute/path/to/pi-http.config.json
node "$SERVICE" restart --http-config /absolute/path/to/pi-http.config.json
node "$SERVICE" status --http-config /absolute/path/to/pi-http.config.json
node "$SERVICE" logs --http-config /absolute/path/to/pi-http.config.json
node "$SERVICE" uninstall --http-config /absolute/path/to/pi-http.config.json
```

`install` writes the service definition and enables startup at login, but does not immediately start Pi. `start` waits for the HTTP extension to confirm readiness. `stop` shuts down gracefully; `restart` stops gracefully and then starts again. `uninstall` disables automatic startup while preserving configuration, credentials, logs, and chat data. Before updating code or installation arguments, run `stop`, update, run `install`, and then `start`. Ordinary HTTP configuration changes only require `restart`.

Background services do not read shell files such as `.zshrc` or `.bashrc`. Installation captures `PATH`, the HTTP key, and optional `PI_CODING_AGENT_DIR`, and reuses the generated environment file. Put extra provider environment variables in `environment.json`, or import a JSON object with string values using `install --env-file /absolute/path/to/variables.json`. An explicit environment file overrides the current shell, whose values override previously saved values. Imports copy values; later edits to the source file do not take effect automatically.

`paths.config_dir` controls `service.json`, `environment.json`, and `status.json`. `logging.directory` controls HTTP logs and the macOS launcher log. Service definitions must remain in the locations required by the operating system: `~/.config/systemd/user/pi-http.service` on Linux, and `~/Library/LaunchAgents/dev.pi-http.plist` on macOS. Each user manages one service by default.

Installation records absolute paths to Node, Pi, and the extension package. Reinstall the service definition after moving directories or changing runtime installation paths. Keep real configuration, databases, and attachments out of package caches or temporary directories that may be deleted during upgrades. Foreground and background Pi must not use the same listener port or database at the same time.

The default startup deadline is 60 seconds; adjust it with `install --startup-timeout 120`. The total shutdown deadline is `max(45, HTTP shutdown_grace_seconds + 10)`. Override it with `--stop-timeout`, which must exceed the HTTP grace period. Reinstall the service definition after increasing that grace period. Processes are forcibly stopped after the deadline, and interrupted requests are not automatically rerun. Background operation cannot answer human confirmations; HTTP execution that requires interaction returns `interaction_required`.

### Linux

Installation runs `systemctl --user daemon-reload` and `enable pi-http.service`. Failed services retry every 5 seconds, with at most 5 starts in 60 seconds. After fixing the problem, run `start` to clear the failure counter. systemd may show `active` before HTTP is ready; use the management command's `runtime.state: "ready"` as the readiness indicator.

`logs` follows the HTTP log file. View timestamped launcher process logs with:

```bash
journalctl --user -u pi-http.service -n 100 -f
```

A working systemd user manager is required. The default service starts at login. To keep it running without a logged-in user or start it after system boot, have an administrator enable `loginctl enable-linger "$USER"` for the account. The installer does not convert it into a root system service.

### macOS

Requires the current user's GUI login domain. On first start, `start` uses `launchctl bootstrap gui/<UID> <plist>`; an already loaded job uses `kickstart`. `stop` unloads the job with `bootout`, preventing an immediate restart. Unexpected exits trigger restarts with a throttle interval of approximately 5 seconds or longer. If the plist is retained, the job starts again at the next login. Use `uninstall` to disable it permanently.

`logs` follows both HTTP and launcher logs. Launcher logs include UTC timestamps. `service.log` is not rotated automatically; configure system log rotation for long-running deployments. A LaunchAgent runs after login and stops at logout. Locking the screen or closing the terminal does not stop it, but the machine cannot serve requests while asleep. A system-level LaunchDaemon is not provided.

### Upgrading older deployments

An existing `pi-http.config.json` in the working directory is still recognized. Before upgrading, set its `paths.data_dir` to the writable root you want to use. Existing explicit `chat.storage_dir` and `storage.database_path` values are preserved; files are not moved automatically.

An older background service's existing `service.json` can still run directly. If no main configuration is specified or found, the management entry point tries the old user service configuration directory. Before migrating service configuration, stop the old service, copy the environment file you want to keep, and run `install` with the new main configuration. Then pass the new `--http-config` path to all management commands. Do not change paths while the old service is running.

## Packaging

```bash
npm pack --ignore-scripts
```

The package contains TypeScript extension source, background service scripts, documentation, example configuration, and the MIT license. It excludes the SDK, real configuration, keys, chat directories, and databases. You can also install directly from this project's Git repository:

```bash
pi install git:github.com/wwyy456258/pi-http
```

The first npm release has not been published. See the [publishing guide (Chinese)](docs/publishing.md) for release configuration, account and package name checks, manual publication, and Pi catalog verification. To prepare a release locally without uploading:

```bash
npm run release:check
```

This command runs type checking, tests, and a package preview. A future `npm publish` also runs these checks first. Git commits and pushes do not trigger an npm release.

## API examples

List models:

```bash
curl http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer $PI_HTTP_API_KEY"
```

Start a chat, automatically creating the chat directory and conversation:

```bash
curl http://127.0.0.1:3000/v1/chat \
  -H "Authorization: Bearer $PI_HTTP_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-first-message-001' \
  -d '{"message":"Describe the current working directory","ttl_seconds":86400}'
```

Save the returned `chat_id` and continue the conversation:

```bash
curl http://127.0.0.1:3000/v1/chat \
  -H "Authorization: Bearer $PI_HTTP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"<chat ID from the previous response>","message":"Tell me more"}'
```

Attach files to a message. The `payload` field must come before `files`:

```bash
curl http://127.0.0.1:3000/v1/chat \
  -H "Authorization: Bearer $PI_HTTP_API_KEY" \
  -F 'payload={"message":"Analyze these documents"}' \
  -F 'files=@/absolute/path/to/report.pdf' \
  -F 'files=@/absolute/path/to/data.csv'
```

Files have no default type, size, or count restrictions. They are streamed into the chat directory and read by Pi as needed. Configure `upload` to limit sizes or file counts; `0` means unlimited. Pi's working directory does not switch to the attachment directory.

Chat requests wait synchronously for the final result. A client disconnect requests cancellation; tool operations that have already happened are not rolled back. The optional `Idempotency-Key` replays the result of the same submission. Use a new key to execute again. A busy chat returns `409`; an expired chat returns `410`. Chat cleanup does not delete native Pi session files.

## Development and verification

```bash
npm run check
npm run build
npm test
```

On macOS, you can also run the native launchd test. It creates a uniquely named temporary job, verifies crash restarts, old Pi process cleanup, and graceful shutdown, then unloads the job:

```bash
PI_HTTP_TEST_LAUNCHD=1 node --test test/launchd.test.mjs
```

Configuration and logging tests cover initialization without overwriting existing files, key fallback, automatic directory creation, request input and output, file sizes, log rotation, body truncation, and credential redaction in errors. Service tests cover definition generation and management commands for both platforms, permissions and path escaping, keeping RPC input open, startup failures and timeouts, signal forwarding, and forced termination. macOS tests validate generated plists with system `plutil`. Pi integration tests also launch the real Pi CLI through the background launcher, execute HTTP chat and tool calls, and check shutdown cleanup and port conflicts. Management commands use an isolated mock executor and do not install persistent services on the test machine. Actual systemd operation still needs acceptance testing on Linux.

Other tests cover HTTP authentication, model precedence, chat continuation, binary attachments, failed-upload cleanup, concurrency, idempotency, expiration, real socket disconnects, and HTTP restarts. Pi integration tests use real `pi install`, package discovery, and extension loading to verify `/http` lifecycle operations, inheritance of host models and runtime credentials, isolation from the foreground conversation, and cleanup on exit and reload. Packaging tests extract the actual npm artifact, link only declared runtime dependencies without the development Pi SDK, and let the host Pi install and invoke it. Tests use isolated temporary configuration and a local mock model. They do not read real provider credentials or call paid models, and require permission to bind temporary local ports.

State is stored in Node's built-in SQLite. A database can be used by only one service process at a time, enforced with a process lock. A lock left by an abnormal exit can take about 10 seconds to become stale; startup retries briefly. Unfinished requests recover as interrupted and are not automatically rerun.

## License

This project uses the [MIT License](LICENSE).
