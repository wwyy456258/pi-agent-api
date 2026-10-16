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

## 打包

```bash
npm pack --ignore-scripts
```

发布包包含 TypeScript 扩展源码、文档和示例配置，不包含 SDK、真实配置、密钥、聊天目录或数据库。源码包也可从 Git 安装：

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

测试覆盖 HTTP 鉴权、模型优先级、会话续接、二进制附件、上传失败清理、并发、幂等、到期、真实连接断开与 HTTP 重启。Pi 集成测试使用真实 `pi install`、包发现和扩展加载器，验证 `/http` 启停、宿主模型及运行时凭据继承、内部会话不污染前台对话，以及退出与重载清理。打包测试会解压实际 npm 产物，只链接声明的运行依赖，不放入开发用 Pi SDK，再由宿主 Pi 完成安装和调用。测试使用独立临时配置和本机模拟模型，不读取真实供应商凭据或调用付费模型，需要能够绑定本机临时端口。

状态存储使用 Node 内置 SQLite；同一数据库仅供一个服务进程使用，并通过进程锁防止同时启动。异常退出后的锁最多需要约 10 秒失效，启动过程会短暂重试；未完成请求恢复为中断状态，不自动重跑。
