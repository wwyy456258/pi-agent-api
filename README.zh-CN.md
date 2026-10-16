# pi-agent-api

[English](README.md) | **简体中文**

[GitHub 仓库](https://github.com/wwyy456258/pi-http) | [问题反馈](https://github.com/wwyy456258/pi-http/issues)

Pi 扩展包，在 Pi 进程内通过 HTTP 为第三方项目提供 AI 与工具执行能力，支持多轮聊天、可选文件附件和模型选择。

首版提供两个业务接口：

- `POST /v1/chat`：聊天，自动创建或继续会话，可随请求上传文件。
- `GET /v1/models`：获取可选模型与当前默认模型。

聊天统一等待执行结束后返回 JSON，不使用 SSE。初始化会在私有 `environment.json` 中生成 API Key，也可通过 `PI_HTTP_API_KEY` 环境变量覆盖；调用方使用 `Authorization: Bearer <API Key>` 鉴权。

HTTP 接入沿用直接运行 Pi 的权限，不额外限制工具、文件访问或网络访问。

接口契约、API Key 配置、文件存储、会话清理和异常处理规则见 [项目设计](docs/design.md)。扩展由 Pi 加载，HTTP 聊天使用各自的内部 Pi session，不写入前台交互会话。

## 安装后什么时候配置

需要 Node.js 22.19 或更新版本，并已安装 Pi，当前以 Pi 1.3.0 验证。先在 Pi 中配置模型和供应商凭据。

首次发布后，可通过 npm 安装：

```bash
pi install npm:pi-agent-api
```

本地开发时，在克隆的仓库中安装依赖并注册目录：

```bash
npm ci --ignore-scripts
pi install /absolute/path/to/pi-agent-api
```

**安装只负责让 Pi 发现扩展，不会启动 HTTP 或自动写入机器配置。第一次启动 HTTP 前执行初始化，编辑配置，再启动。** 后续升级保留现有配置。

前台 Pi 中可以直接操作：

```text
/http init
/http config
/http start
/http status
/http stop
```

`/http init` 默认在 `/data/pi-agent-api` 创建配置、环境文件和数据目录，并生成 HTTP API Key（已导出的 Key 会被沿用）；不会覆盖已有配置或密钥。编辑下面的主配置文件后执行 `/http start`。

| 用途 | 默认位置 |
| --- | --- |
| HTTP 主配置 | `/data/pi-agent-api/config/pi-agent-api.config.json` |
| HTTP Key、后台环境变量 | `/data/pi-agent-api/config/environment.json` |
| 后台服务参数、状态 | `/data/pi-agent-api/config/service.json`、`status.json` |
| 聊天附件 | `/data/pi-agent-api/chats/` |
| 每个聊天的入参、出参 | `/data/pi-agent-api/chats/<chat_id>/conversation.jsonl` |
| 状态数据库 | `/data/pi-agent-api/pi-agent-api.sqlite` |
| HTTP 接口日志 | `/data/pi-agent-api/logs/http.jsonl` |
| macOS 后台启动器日志 | `/data/pi-agent-api/logs/service.log` |

目录不存在时自动递归创建，创建目录权限为 `0700`，配置、密钥、日志文件为 `0600`。当前用户无权创建 `/data/pi-agent-api` 时会提示具体失败路径；可以先让管理员创建并授权该目录，或使用当前用户可写的位置：

```text
/http init /absolute/writable/path/pi-agent-api
```

此命令会打印实际配置及环境文件路径，不打印密钥。当前 Pi 随后的 `/http start` 使用该配置；下次启动 Pi 时使用打印出的 `--http-config` 路径。

也可在终端初始化，无需先进入 Pi：

```bash
SERVICE=/absolute/path/to/pi-agent-api/scripts/service.mjs
node "$SERVICE" init
# 自定义数据根目录：
node "$SERVICE" init --data-dir /absolute/writable/path/pi-agent-api
# 指定主配置文件的位置：
node "$SERVICE" init --data-dir /absolute/writable/path/pi-agent-api \
  --http-config /absolute/path/to/pi-agent-api.config.json
```

### 配置目录和模型

配置示例见 `pi-agent-api.config.example.json`。只修改 `paths.data_dir`，其余未显式覆盖的路径会随它改变；以下字段可以单独覆盖目录或文件路径：

| 配置字段 | 未配置时的值 |
| --- | --- |
| `paths.data_dir` | `/data/pi-agent-api` |
| `paths.config_dir` | `<data_dir>/config`，保存环境、后台服务配置和状态 |
| `logging.directory` | `<data_dir>/logs` |
| `chat.storage_dir` | `<data_dir>/chats` |
| `storage.database_path` | `<data_dir>/pi-agent-api.sqlite` |

显式配置的相对路径以主配置文件所在目录为基准。主配置文件自身的位置由 `--http-config` 指定，无法通过文件里面的 `paths.config_dir` 移动自己。修改路径不会迁移旧数据库、附件或环境文件，需要部署者迁移或继续显式指定原路径。

主配置查找顺序：`--http-config <path>` → 工作目录 `pi-agent-api.config.json` → 工作目录 `pi-http.config.json` → `/data/pi-agent-api/config/pi-agent-api.config.json` → 旧 `/data/pi-http/config/pi-http.config.json`。`/http config` 可显示当前读取的配置及解析后的目录，不显示密钥。

```bash
pi --http --http-config /absolute/path/to/pi-agent-api.config.json
```

默认监听 `127.0.0.1:3000`。局域网接入需要把 `server.host` 改为指定网卡地址或 `0.0.0.0`，并设置所需 `server.port`。HTTP 模型选择顺序：请求 `model` → 配置 `model.default` → 宿主 Pi 当前选择的默认模型；可用模型由 `/v1/models` 查询。

配置修改后 `/http stop`、`/http start` 生效。`--http` 会在 Pi 会话启动或重载完成后自动监听；Pi 退出或切换会话时关闭当前监听。HTTP 聊天保存在各自的内部 Pi session，前台对话不加入这些消息。

### API Key 在哪里

初始化生成或沿用的 HTTP API Key 位于上述 `environment.json` 的 `PI_HTTP_API_KEY` 字段。将这个 Key 配置给调用方，使用 `Authorization: Bearer <Key>`。也可自行用 `openssl rand -hex 32` 生成并替换该字段。

下方 curl 示例需要先设置 `export PI_HTTP_API_KEY='<环境文件中的 Key>'`。

前台扩展优先读取 Pi 进程环境中的 `PI_HTTP_API_KEY`，未设置时读取 `paths.config_dir/environment.json`；其他模型供应商凭据仍由 Pi 自己管理。不要将 HTTP Key 写入业务配置文件、仓库或请求日志。

更换进程环境变量中的 Key 需要重启 Pi；使用环境文件中的 Key 时，前台 `/http stop` 后 `/http start` 重新读取，后台服务执行 `restart`。已有进程环境变量会覆盖环境文件中的同名 Key。

## 接口日志

默认启用文件日志，前台 Pi 和后台运行都写入 `logging.directory/http.jsonl`，每行一个 JSON 对象：

- `request_received`：UTC 时间、请求 ID、HTTP 方法、路径、来源 IP。
- `request_input`：通过鉴权和格式校验后的 JSON 输入，在模型执行前记录。
- `response_sent`：UTC 时间、同一请求 ID、状态码、耗时毫秒、输入和输出、响应字节数，以及文件数量、各文件字节数和总字节数。
- `request_aborted`：客户端断开，记录已接收的文件大小，状态记为 `499`。

鉴权失败、参数错误和上游错误也会记录；未通过鉴权的请求不记录业务输入。附件只记数量和大小，不记文件名、路径、内容或二进制数据。请求头、URL 查询参数不会进入日志，已知凭据和 Bearer Token 会脱敏。错误详情保留可用于排查的部分。

默认记录聊天输入与回复；`logging.log_bodies: false` 可仅保留元数据。`logging.max_body_chars` 默认 `16384`，超出部分使用带 `truncated` 标记的预览。接口日志按 `logging.max_file_bytes`（默认 10 MiB）轮转，最多保留 `logging.max_files`（默认 7）个归档，名称为 `http.jsonl.1` 等；一条记录不会被拆分。

```bash
tail -n 100 -F /data/pi-agent-api/logs/http.jsonl
```

日志目录无法创建或文件无法打开时，HTTP 启动会报错。运行中写入失败会带时间和路径报告到 stderr，业务请求仍可继续。聊天 TTL 不控制这份全局接口日志的保留。

### 每个聊天的入参、出参

每个聊天另有一份 `chat.storage_dir/<chat_id>/conversation.jsonl`，默认位于 `/data/pi-agent-api/chats/<chat_id>/conversation.jsonl`。每个执行完成的轮次追加一行 JSON，包含完整 JSON `input` 和 `output`、UTC 完成时间 `time`、`started_at`、`chat_id`、`request_id`、实际使用的 `model`、`status`、执行耗时 `duration_ms` 和附件数量、大小。文本中的换行会在 JSON 中转义，每轮始终占一行。简化示例：

```jsonl
{"event":"chat_turn","chat_id":"chat_example","request_id":"req_1","input":{"message":"你好"},"output":{"reply":"你好！"}}
{"event":"chat_turn","chat_id":"chat_example","request_id":"req_2","input":{"chat_id":"chat_example","message":"继续聊"},"output":{"reply":"继续之前的话题。"}}
```

相同 `chat_id` 的后续消息持续追加到同一个文件，服务重启后也不会覆盖。幂等重放不重复追加。已执行但失败或被取消的轮次也会记录错误出参；被拒绝的请求、进程崩溃时未完成的请求，可通过全局接口日志排查。新建对话记录文件权限为 `0600`。

对话入参、出参沿用接口日志的凭据脱敏和 `logging.log_bodies` 开关，保存完整正文，不受 `logging.max_body_chars` 预览截断影响，也不轮转成多个文件。附件只记录数量和字节数。`logging.enabled: false` 关闭两类日志，`logging.log_bodies: false` 只保留元数据。聊天过期清理目录时，对话 JSONL 一并删除；全局接口日志继续按自己的轮转规则保留。

## 后台运行与自动重启

Linux 使用当前用户的 systemd user service，macOS 使用当前用户的 launchd LaunchAgent。启动器运行真实 Pi CLI 的 RPC 模式，加载本扩展、保持输入管道、等待 HTTP 就绪并转发停止信号；异常重启交给操作系统处理。

完成初始化、编辑配置，并在目标 Pi 工作目录完成模型配置和需要的信任授权后安装后台服务：

```bash
SERVICE=/absolute/path/to/pi-agent-api/scripts/service.mjs
node "$SERVICE" init
# 先编辑 /data/pi-agent-api/config/pi-agent-api.config.json，再安装：
node "$SERVICE" install --cwd /absolute/path/to/workspace --pi "$(command -v pi)"
node "$SERVICE" start
node "$SERVICE" status
node "$SERVICE" logs
```

自定义主配置路径时，安装和后续管理均带上同一个参数：

```bash
node "$SERVICE" install --http-config /absolute/path/to/pi-agent-api.config.json \
  --cwd /absolute/path/to/workspace --pi "$(command -v pi)"
node "$SERVICE" start --http-config /absolute/path/to/pi-agent-api.config.json
node "$SERVICE" stop --http-config /absolute/path/to/pi-agent-api.config.json
node "$SERVICE" restart --http-config /absolute/path/to/pi-agent-api.config.json
node "$SERVICE" status --http-config /absolute/path/to/pi-agent-api.config.json
node "$SERVICE" logs --http-config /absolute/path/to/pi-agent-api.config.json
node "$SERVICE" uninstall --http-config /absolute/path/to/pi-agent-api.config.json
```

`install` 写服务定义，配置登录后自动启动，但不会立即启动。`start` 等待 HTTP 扩展确认就绪才返回成功。`stop` 正常停止，`restart` 正常停止后再启动，`uninstall` 取消自动启动并保留配置、凭据、日志和聊天数据。更新代码或安装参数前先 `stop`，再更新代码、`install` 和 `start`；普通 HTTP 配置变更只需 `restart`。

后台服务不会读取 shell 的 `.zshrc` 或 `.bashrc`。安装时保存 `PATH`、HTTP Key、可选 `PI_CODING_AGENT_DIR`，并沿用生成的环境文件。额外的供应商环境变量写入 `environment.json`，或用 `install --env-file /absolute/path/to/variables.json` 导入 JSON 对象（值必须为字符串）；显式环境文件优先于当前 shell，同名 shell 变量优先于已保存的值。导入是复制，后续修改源文件不生效。

`paths.config_dir` 控制 `service.json`、`environment.json`、`status.json`；`logging.directory` 控制接口日志及 macOS 启动器日志。服务定义必须放在操作系统要求的位置：Linux 为 `~/.config/systemd/user/pi-agent-api.service`，macOS 为 `~/Library/LaunchAgents/dev.pi-agent-api.plist`。每个用户默认管理一个服务。

服务记录安装时 Node、Pi 和扩展包的绝对路径。移动目录或更换运行时安装位置后重新安装服务定义。不要将真实配置、数据库或附件放到升级时会删除的包缓存或临时目录。前后台 Pi 不要同时监听相同端口或打开同一数据库。

默认启动期限 60 秒，可用 `install --startup-timeout 120` 调整。总停止期限为 `max(45, HTTP shutdown_grace_seconds + 10)`，可通过 `--stop-timeout` 设置，必须大于 HTTP 宽限；增加 HTTP 宽限后重新安装服务定义。超过期限会强制停止，已中断请求不自动重跑。后台模式不能代替用户完成确认，HTTP 执行遇到必须交互时返回 `interaction_required`。

### Linux

安装器执行 `systemctl --user daemon-reload` 和 `enable pi-agent-api.service`。失败后每 5 秒重试，60 秒最多启动 5 次；修正后运行 `start`，会清除失败计数。systemd 在 HTTP 确认就绪前可能已显示 `active`，以管理入口 `runtime.state: "ready"` 为准。

`logs` 查看接口文件日志；启动器的进程日志（含时间）通过下面命令查看：

```bash
journalctl --user -u pi-agent-api.service -n 100 -f
```

需要可用的 systemd 用户管理器。默认随用户登录启动；无人登录或系统启动后也要运行时，由管理员为该用户启用 `loginctl enable-linger "$USER"`。不会自动改成 root 系统服务。

### macOS

需要当前用户 GUI 登录域。`start` 首次使用 `launchctl bootstrap gui/<UID> <plist>`，已加载时使用 `kickstart`；`stop` 使用 `bootout` 卸载，避免立即拉起。异常退出会自动重启，重试间隔至少约 5 秒。保留 plist 时下次登录仍自动运行，永久取消用 `uninstall`。

`logs` 同时查看 HTTP 和启动器日志，启动器日志含 UTC 时间。`service.log` 不自动轮转，长期部署可由系统配置轮转。LaunchAgent 在用户登录后运行，注销会停止；锁屏或关闭终端不会停止，机器睡眠时无法处理请求。未提供系统级 LaunchDaemon。

### 旧部署升级

新部署使用 `/data/pi-agent-api`、`pi-agent-api.config.json` 和 `pi-agent-api.sqlite`。配置查找顺序为：显式 `--http-config` → 工作目录中新文件名 → 工作目录中旧文件名 → 新默认配置 → 旧 `/data/pi-http/config/pi-http.config.json`。文件名为 `pi-http.config.json` 的配置继续使用旧的默认数据根目录和数据库名；显式路径配置始终优先。已有文件不会自动搬迁。

安装改名后的后台服务前，先移除旧 systemd/launchd 注册。下面的命令会保留旧配置、密钥、附件、数据库和日志，再以新服务名使用原配置：

```bash
node "$SERVICE" status --legacy-service --http-config /data/pi-http/config/pi-http.config.json
node "$SERVICE" uninstall --legacy-service --http-config /data/pi-http/config/pi-http.config.json
node "$SERVICE" install --http-config /data/pi-http/config/pi-http.config.json --cwd /absolute/path/to/work
node "$SERVICE" start --http-config /data/pi-http/config/pi-http.config.json
```

`--legacy-service` 仅支持 `stop`、`status`、`logs`、`uninstall`，操作 `pi-http.service` 或 `dev.pi-http`。未显式指定配置时，它查找旧工作目录/默认配置；更早的部署还会查找旧用户服务配置目录。旧服务定义仍存在时安装会拒绝继续，避免同时注册两个服务。普通管理命令操作 `pi-agent-api.service` 或 `dev.pi-agent-api`。

如需使用新配置目录并保留已有聊天，先停止旧服务、复制私有环境文件，再在新配置中将 `chat.storage_dir` 和 `storage.database_path` 显式指向原来的绝对位置后重新安装。既有 Pi session 和聊天历史可能记录绝对文件路径，应保持这些位置可访问；搬迁历史附件需要单独的数据迁移，目前不会自动处理。不要让新旧服务同时操作同一份数据。

## 包名与已有部署

包名为 `pi-agent-api`，后台管理命令为 `pi-agent-api-service`；`pi-http-service` 保留为指向同一脚本的兼容别名，使用新的默认值。移除旧服务时按上文传入 `--legacy-service`。使用源码目录时可通过 `node "$SERVICE"` 执行。

配置示例为 `pi-agent-api.config.example.json`。`PI_HTTP_API_KEY`、`/http` 和 `--http` / `--http-config` 参数保持原有含义，目录仍可通过配置覆盖。

GitHub 仓库目前仍为 `wwyy456258/pi-http`。克隆时可将本地目录命名为 `pi-agent-api`，与源码路径示例一致；仓库链接继续使用实际远端名称。

## 打包

```bash
npm pack --ignore-scripts
```

发布包包含 TypeScript 扩展源码、后台服务管理脚本、文档、示例配置和 MIT 许可证，不包含 SDK、真实配置、密钥、聊天目录或数据库。源码包也可从本项目 Git 仓库安装：

```bash
pi install git:github.com/wwyy456258/pi-http
```

npm 包名为 `pi-agent-api`。发布配置、账号和包名确认、手动发布及 Pi 包目录验证见 [发布说明](docs/publishing.md)。只做本地发布准备、不上传：

```bash
npm run release:check
```

该命令执行类型检查、测试和打包预览。执行 `npm publish` 时也会先自动运行这些检查；提交或推送 Git 不触发 npm 发布。

## 调用示例

查询模型：

```bash
curl http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer $PI_HTTP_API_KEY"
```

首次聊天，自动创建聊天目录与对话：

```bash
curl http://127.0.0.1:3000/v1/chat \
  -H "Authorization: Bearer $PI_HTTP_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-first-message-001' \
  -d '{"message":"介绍一下当前工作目录","ttl_seconds":86400}'
```

保存响应中的 `chat_id`，继续对话：

```bash
curl http://127.0.0.1:3000/v1/chat \
  -H "Authorization: Bearer $PI_HTTP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"<上次返回的聊天ID>","message":"再详细说说"}'
```

随消息附带文件，`payload` 必须放在 `files` 前面：

```bash
curl http://127.0.0.1:3000/v1/chat \
  -H "Authorization: Bearer $PI_HTTP_API_KEY" \
  -F 'payload={"message":"分析这些资料"}' \
  -F 'files=@/absolute/path/to/report.pdf' \
  -F 'files=@/absolute/path/to/data.csv'
```

文件默认不限类型、大小和数量，按流保存到聊天目录，需要时由 Pi 读取。通过 `upload` 配置可限制大小和数量，`0` 表示不限。Pi 的工作目录不会切换到附件目录。

聊天请求同步等待最终结果；客户端断线会请求取消，已经发生的工具操作不会回滚。可选 `Idempotency-Key` 用于重放同一次提交的结果，重新执行必须换新的 Key。同一聊天忙碌时返回 `409`，到期后返回 `410`。聊天清理不会删除 Pi 原生 session 文件。

## 开发与验证

```bash
npm run check
npm run build
npm test
```

macOS 可额外运行原生 launchd 测试，使用唯一临时任务验证崩溃重启、旧 Pi 进程回收和正常停止，结束后卸载任务：

```bash
PI_HTTP_TEST_LAUNCHD=1 node --test test/launchd.test.mjs
```

配置和日志测试覆盖初始化不覆盖现有文件、密钥回退、目录自动创建、接口输入输出、文件大小、日志轮转、正文截断和错误凭据脱敏。服务测试覆盖两种平台的定义生成与管理命令、权限和路径转义、RPC 输入保持、启动失败与超时、停止信号和强制退出；macOS 使用系统 `plutil` 校验生成的 plist。Pi 集成测试还会启动真实 Pi CLI，通过后台启动器执行 HTTP 聊天和工具调用，并验证退出清理与端口占用失败。服务管理命令用隔离的模拟执行器验证，不会给测试机器安装长期后台任务；Linux systemd 的实际运行需要在 Linux 上验收。

其余测试覆盖 HTTP 鉴权、模型优先级、会话续接、二进制附件、上传失败清理、并发、幂等、到期、真实连接断开与 HTTP 重启。Pi 集成测试使用真实 `pi install`、包发现和扩展加载器，验证 `/http` 启停、宿主模型及运行时凭据继承、内部会话不污染前台对话，以及退出与重载清理。打包测试会解压实际 npm 产物，只链接声明的运行依赖，不放入开发用 Pi SDK，再由宿主 Pi 完成安装和调用。测试使用独立临时配置和本机模拟模型，不读取真实供应商凭据或调用付费模型，需要能够绑定本机临时端口。

状态存储使用 Node 内置 SQLite；同一数据库仅供一个服务进程使用，并通过进程锁防止同时启动。异常退出后的锁最多需要约 10 秒失效，启动过程会短暂重试；未完成请求恢复为中断状态，不自动重跑。

## 许可证

本项目使用 [MIT License](LICENSE)。
