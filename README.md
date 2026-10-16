# pi-http

Pi 扩展包，在 Pi 进程内通过 HTTP 为第三方项目提供 AI 与工具执行能力，支持多轮聊天、可选文件附件和模型选择。

首版提供两个业务接口：

- `POST /v1/chat`：聊天，自动创建或继续会话，可随请求上传文件。
- `GET /v1/models`：获取可选模型与当前默认模型。

聊天统一等待执行结束后返回 JSON，不使用 SSE。API Key 由部署者本地生成，通过 `PI_HTTP_API_KEY` 环境变量配置，调用方使用 `Authorization: Bearer <API Key>` 鉴权。

HTTP 接入沿用直接运行 Pi 的权限，不额外限制工具、文件访问或网络访问。

接口契约、API Key 配置、文件存储、会话清理和异常处理规则见 [项目设计](docs/design.md)。扩展由 Pi 加载，HTTP 聊天使用各自的内部 Pi session，不写入前台交互会话。

## 安装与启动

需要 Node.js 22.19 或更新版本，并已安装 Pi。当前以 Pi 1.3.0 开发和验证。先在 Pi 中配置好模型和供应商凭据；扩展沿用宿主 Pi 的模型与凭据，HTTP API Key 只用于调用鉴权。

开发目录本地安装：

```bash
npm ci --ignore-scripts
pi install /Users/wangyi/workspace/code/pi-http
```

Pi 按 `package.json` 中的 `pi.extensions` 加载 `src/extension.ts`，无需先构建 JavaScript。Pi SDK 是宿主提供的 peer dependency；本地开发时安装的 SDK 只用于类型检查与测试，不作为扩展运行依赖随包分发。

用 `openssl rand -hex 32` 生成 HTTP API Key，在启动 Pi 前设置环境变量：

```bash
export PI_HTTP_API_KEY='<生成的密钥>'
pi
```

在 Pi 中执行：

```text
/http start
/http status
/http stop
```

扩展默认只注册命令。需要在 Pi 启动时自动打开 HTTP 监听，可使用：

```bash
pi --http
```

默认监听 `http://127.0.0.1:3000`。没有请求级或扩展配置的默认模型时，沿用宿主 Pi 当前选择的模型；宿主切换模型后，后续 HTTP 请求也会使用新的默认选择。聊天默认保留至最后一次执行结束后的 24 小时。

需要调整配置时，在 Pi 工作目录下将 `pi-http.config.example.json` 复制为 `pi-http.config.json`，也可通过扩展参数显式指定：

```bash
pi --http --http-config /absolute/path/to/pi-http.config.json
```

例如，要设置扩展默认模型，在配置文件中增加 `"model": { "default": "供应商/模型ID" }`；可用 ID 通过模型列表接口获取。优先级为请求 `model`、配置 `model.default`、宿主 Pi 的默认选择。

配置修改后执行 `/http stop` 和 `/http start` 生效。API Key 从 Pi 进程环境读取，更换环境变量中的密钥需要重新启动 Pi。

Pi 退出、重载或切换前台会话时会关闭 HTTP 监听。使用 `--http` 时，新会话或重载完成后自动重新启动；否则可再次执行 `/http start`。缺少 API Key 或端口被占用时，只报告 HTTP 启动失败，仍可正常使用 Pi。

## 后台运行与自动重启

Linux 使用当前用户的 **systemd user service**；macOS 使用当前用户的 **launchd LaunchAgent**。扩展包提供 `pi-http-service` 管理入口，启动的仍是加载本扩展的真实 Pi CLI：`pi --mode rpc -e <扩展包路径> --http --http-config <配置路径>`。启动器保持 RPC 输入管道打开、消费输出、等待 HTTP 扩展就绪，并转发停止信号。崩溃后的重启由操作系统负责。

### 安装后台服务

先完成前面的依赖安装和 Pi 模型配置，并在目标工作目录交互运行一次 Pi，完成该目录需要的信任或授权。后台运行无法处理人工确认；HTTP 执行中遇到需要用户交互的扩展时返回 `interaction_required`。

将扩展包保存在稳定目录，HTTP 配置和数据也使用稳定路径。服务记录安装时 Node、Pi 和扩展包的绝对路径；移动目录或更换 Node/Pi 安装位置后，需要停止服务并重新安装服务定义。

下面的命令在 Linux 和 macOS 通用，替换其中的路径：

```bash
# Pi 必须已经在 PATH 中；可先用 command -v pi 确认。
export PI_HTTP_API_KEY='<使用 openssl rand -hex 32 生成的密钥>'
SERVICE=/absolute/path/to/pi-http/scripts/service.mjs

# 必须存在此配置文件，可从 pi-http.config.example.json 复制。
node "$SERVICE" install \
  --cwd /absolute/path/to/workspace \
  --http-config /absolute/path/to/pi-http.config.json \
  --pi "$(command -v pi)"

node "$SERVICE" start
node "$SERVICE" status
```

这里用 `node <脚本路径>`，不要求 Pi 的包安装目录加入 PATH。如果通过 npm 的 bin 链接访问，也可直接使用 `pi-http-service <命令>`。支持 `--pi` 指向 Pi 可执行文件或 CLI 的 `.js` / `.mjs` / `.cjs` 文件。

`install` 写入服务定义并配置登录后自动启动，**不会立即启动 Pi**；`start` 等待本次 Pi 进程里的 HTTP 扩展确认就绪才返回成功。默认启动等待 60 秒，可在安装时传 `--startup-timeout 120`。端口占用、配置错误和超时会导致启动器以非零状态退出，交给服务管理器处理；修正后执行 `start` 或 `restart`。

HTTP 配置中的 `pi.cwd` 可以进一步指定工具工作目录；没有配置时沿用 `--cwd`。配置中的相对数据路径以 HTTP 配置文件所在目录为基准。不要把数据库或聊天目录放在临时目录、包下载缓存或升级时会删除的目录里。前台 Pi 和后台 Pi 不要同时打开同一个 HTTP 端口及数据库。

### 环境变量与 API Key

安装时会保存当前 `PATH`、`PI_HTTP_API_KEY` 和可选的 `PI_CODING_AGENT_DIR`。其他供应商环境变量需要通过 `--env-file` 显式提供；后台服务不会读取 `.zshrc`、`.bashrc` 或执行登录 shell。

`--env-file` 使用 JSON 对象，所有值必须为字符串，例如：

```json
{
  "PI_HTTP_API_KEY": "<HTTP 调用密钥>",
  "OPENAI_API_KEY": "<如果供应商凭据来自环境变量，在这里提供>",
  "PI_CODING_AGENT_DIR": "/absolute/path/to/pi-agent-dir"
}
```

```bash
chmod 600 /absolute/path/to/service-env.json
node "$SERVICE" install \
  --cwd /absolute/path/to/workspace \
  --http-config /absolute/path/to/pi-http.config.json \
  --env-file /absolute/path/to/service-env.json
```

文件中的变量覆盖安装时捕获的同名变量，并复制到服务自己的 `environment.json`，后续修改源文件不会自动生效。若使用 Pi 保存的供应商凭据，不需要再填供应商 Key；`PI_HTTP_API_KEY` 始终是独立的 HTTP 调用密钥。

| 平台 | 服务配置与环境文件目录 | 服务定义 |
| --- | --- | --- |
| Linux | `~/.config/pi-http/` | `~/.config/systemd/user/pi-http.service` |
| macOS | `~/Library/Application Support/pi-http/` | `~/Library/LaunchAgents/dev.pi-http.plist` |

服务目录权限为 `0700`，`service.json`、`environment.json` 权限为 `0600`。API Key 保存在环境文件中，不写入 systemd unit、launchd plist 或启动参数。更换密钥或其他环境变量后，编辑该 `environment.json`，再执行 `restart`；也可以停止服务后重新 `install --env-file ...`。服务安装器拒绝覆盖已加载或正在运行的服务。

### 启停、日志与更新

```bash
node "$SERVICE" stop
node "$SERVICE" start
node "$SERVICE" restart
node "$SERVICE" status
node "$SERVICE" logs          # 持续查看最近 100 行及新增日志；Ctrl+C 退出查看
node "$SERVICE" uninstall     # 停止并移除服务定义，取消以后自动启动
```

`status` 返回服务管理器是否已加载，以及启动器的状态、PID、Pi 子进程 PID。只有管理器已加载且 HTTP 已就绪时退出码为 0。`uninstall` 保留环境文件、服务配置、日志、HTTP 配置和聊天数据；需要时自行清理这些文件。

正常停止先发送 SIGTERM，让 Pi 关闭扩展并按 HTTP 配置的 `server.shutdown_grace_seconds` 等待请求结束，超过宽限后请求取消。启动器的总停止期限默认为 `max(45, HTTP 宽限秒数 + 10)`，可用 `install --stop-timeout <秒数>` 调整，必须大于 HTTP 宽限；再超时则终止 Pi 的进程组。增加 HTTP 宽限后，需要重新安装服务定义以同步停止期限。`restart` 使用正常停止再启动，正在执行且被中断的请求不会自动重跑。

更新扩展或服务参数的顺序：`stop` → 更新代码/依赖 → `install`（携带完整参数和环境文件）→ `start`。HTTP 普通配置变更只需 `restart`；每个用户默认管理一个名为 `pi-http` 的服务。

### Linux：systemd

需要可用的 systemd 用户服务管理器。安装器执行 `systemctl --user daemon-reload` 和 `enable pi-http.service`；管理命令对应 `systemctl --user`，日志通过 `journalctl --user -u pi-http.service -n 100 -f` 查看。

服务失败后每隔 5 秒重试，60 秒内最多启动 5 次；触发频率限制后会保持失败状态。修正配置后执行 `start`，管理入口会先清除失败计数。启动器确认就绪前，systemd 本身可能已显示 `active`，以管理入口返回的 `runtime.state: "ready"` 为准。

默认随用户登录启动，退出登录后的生命周期取决于系统的用户管理器设置。需要无人登录时运行、机器启动后自动运行，可由系统管理员为该用户启用 linger：

```bash
loginctl enable-linger "$USER"
```

服务始终以该用户身份运行。没有 systemd 用户管理器或没有用户总线的环境，需要先由管理员配置；本项目不自动改成 root 系统服务。

### macOS：launchd

需要当前用户的 GUI 登录域。`start` 首次使用 `launchctl bootstrap gui/<UID> <plist>`，已加载时使用 `kickstart`，`stop` 使用 `bootout` 卸载任务；`restart` 先正常卸载再加载。服务异常退出时 launchd 会重新启动，重试间隔至少约 5 秒。正常的 `stop` 会卸载任务，避免被立即拉起；保留 plist 时下次登录仍会自动启动，要永久取消请用 `uninstall`。

日志写入 `~/Library/Application Support/pi-http/service.log`，`logs` 使用 `tail -n 100 -F` 查看。该日志文件不会自动轮转，需要长期运行时由部署者配置轮转。

这是 **LaunchAgent**：用户登录后运行，注销会停止；单独锁屏或关闭终端不会停止。它不提供未登录时运行的系统级 LaunchDaemon；机器睡眠时也不能处理 HTTP 请求。

## 打包

```bash
npm pack --ignore-scripts
```

发布包包含 TypeScript 扩展源码、后台服务管理脚本、文档和示例配置，不包含 SDK、真实配置、密钥、聊天目录或数据库。源码包也可从 Git 安装：

```bash
pi install git:github.com/<账号>/pi-http@<版本>
```

以上 Git 地址为格式示例，尚未发布仓库或 npm 包。

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

服务测试覆盖两种平台的定义生成与管理命令、权限和路径转义、RPC 输入保持、启动失败与超时、停止信号和强制退出；macOS 使用系统 `plutil` 校验生成的 plist。Pi 集成测试还会启动真实 Pi CLI，通过后台启动器执行 HTTP 聊天和工具调用，并验证退出清理与端口占用失败。服务管理命令用隔离的模拟执行器验证，不会给测试机器安装长期后台任务；Linux systemd 的实际运行需要在 Linux 上验收。

其余测试覆盖 HTTP 鉴权、模型优先级、会话续接、二进制附件、上传失败清理、并发、幂等、到期、真实连接断开与 HTTP 重启。Pi 集成测试使用真实 `pi install`、包发现和扩展加载器，验证 `/http` 启停、宿主模型及运行时凭据继承、内部会话不污染前台对话，以及退出与重载清理。打包测试会解压实际 npm 产物，只链接声明的运行依赖，不放入开发用 Pi SDK，再由宿主 Pi 完成安装和调用。测试使用独立临时配置和本机模拟模型，不读取真实供应商凭据或调用付费模型，需要能够绑定本机临时端口。

状态存储使用 Node 内置 SQLite；同一数据库仅供一个服务进程使用，并通过进程锁防止同时启动。异常退出后的锁最多需要约 10 秒失效，启动过程会短暂重试；未完成请求恢复为中断状态，不自动重跑。
