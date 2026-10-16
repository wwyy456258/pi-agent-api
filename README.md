# pi-http

通过 HTTP 为第三方项目提供 Pi 的 AI 与工具执行能力，支持多轮聊天、可选文件附件和模型选择。

首版提供两个业务接口：

- `POST /v1/chat`：聊天，自动创建或继续会话，可随请求上传文件。
- `GET /v1/models`：获取可选模型与当前默认模型。

聊天统一等待执行结束后返回 JSON，不使用 SSE。API Key 由部署者本地生成，通过 `PI_HTTP_API_KEY` 环境变量配置，调用方使用 `Authorization: Bearer <API Key>` 鉴权。

HTTP 接入沿用直接运行 Pi 的权限，不额外限制工具、文件访问或网络访问。

接口契约、API Key 配置、文件存储、会话清理和异常处理规则见 [项目设计](docs/design.md)。目前按独立服务运行，尚未提供 Pi 插件入口。

## 安装与启动

需要 Node.js 22.19 或更新版本。先在服务使用的 Pi 环境中配置好模型和供应商凭据；服务沿用 Pi 的配置与登录状态，不使用 HTTP API Key 调用模型供应商。

```bash
npm ci --ignore-scripts
npm run build
```

用 `openssl rand -hex 32` 生成服务 API Key，将结果设置到服务进程的环境变量：

```bash
export PI_HTTP_API_KEY='<生成的密钥>'
npm start
```

默认监听 `http://127.0.0.1:3000`，默认模型使用 Pi 的选择，默认聊天保留时间为最后一次执行结束后的 24 小时。

需要调整配置时，复制 `pi-http.config.example.json` 为 `pi-http.config.json`，或显式指定配置文件：

```bash
npm start -- --config /absolute/path/to/pi-http.config.json
```

例如，要设置服务默认模型，在配置文件中增加 `"model": { "default": "供应商/模型ID" }`；可用 ID 通过模型列表接口获取。优先级为请求 `model`、服务 `model.default`、Pi 默认模型。配置和 API Key 修改后重启生效。

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

测试覆盖 HTTP 鉴权、模型优先级、会话续接、二进制附件、上传失败清理、并发、幂等、到期、真实连接断开与服务重启。Pi SDK 集成测试使用独立临时配置和本机模拟模型，验证真实会话历史、模型切换、工具执行及终端交互错误，不读取真实供应商凭据或调用付费模型。测试需要能够绑定本机临时端口。

状态存储使用 Node 内置 SQLite；同一数据库仅供一个服务进程使用，并通过进程锁防止同时启动。异常退出后的锁最多需要约 10 秒失效，启动过程会短暂重试；未完成请求恢复为中断状态，不自动重跑。
