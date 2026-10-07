# DataHub API

DataHub 是一个**极简的"上传 → 生成可分享短链接"** 的 HTTP 后端。
它不解析文件内容、不做 AI 清洗、不做格式转换——只负责**存**和**发**。

清洗 / 转换在本地工具（`DataCleanerProAI` 等）里完成；**让 AI 助手**把两者粘起来。详见 [`docs/AI_ASSISTANT_PROMPT.md`](./docs/AI_ASSISTANT_PROMPT.md) 与 [README.md](./README.md)。

---

## 通用约定

- Base URL：`http://localhost:3000`（默认），可通过 `BASE_URL` 环境变量修改。
- 鉴权：除注册/登录、公开分享接口（`/api/s/...`、`/s/...`）外，需要在 header 里带 `Authorization: Bearer <token>`。
- Content-Type：
  - JSON 请求 → `application/json`
  - 文件上传 → `multipart/form-data`（`file` 字段）
- 错误格式：`{ "error": "..." }`。
- 短链接码：4–32 字符 `[A-Za-z0-9_-]`，由服务端生成。

---

## 1. 账号

### `POST /api/auth/register`

```json
{ "email": "you@example.com", "password": "至少6位" }
```

响应：

```json
{ "token": "eyJ...", "user": { "id": 1, "email": "you@example.com" } }
```

### `POST /api/auth/login`

```json
{ "email": "you@example.com", "password": "xxx" }
```

响应同上。

---

## 2. 上传文件（需登录）

### `POST /api/upload` — `multipart/form-data`

| 字段 | 必填 | 说明 |
|---|---|---|
| `file` | ✅ | 文件本体 |
| `expiresIn` | ❌ | 小时数，0 = 永不过期，默认走 `DEFAULT_EXPIRY_HOURS` |
| `password` | ❌ | 给这个文件单独设一个访问密码（覆盖全局） |
| `note` | ❌ | 备注 |

响应：

```json
{
  "id": "f_abc123",
  "filename": "clean.csv",
  "size": 12345,
  "mime": "text/csv",
  "expiresAt": 1730000000000
}
```

`id`（即 `fileId`）用于下一步开分享。

### `GET /api/files` — 列出自己的文件（需登录）

### `DELETE /api/files/:id` — 删除（需登录，仅本人）

---

## 3. 生成可分享短链接（需登录）

### `POST /api/share`

```json
{
  "fileId": "f_abc123",
  "password": "可选, 字符串",
  "expiresIn": 72,          // 小时, 可选, 0=永不过期
  "code": "可选, 自定义短码(4-32位)"
}
```

响应：

```json
{
  "code": "aB3xY",
  "url": "http://localhost:3000/s/aB3xY",
  "fileId": "f_abc123",
  "expiresAt": 1730000000000,
  "hasPassword": true
}
```

> `url` 字段已经包含了完整可点击地址，**直接复制发给别人就行**。
> 没填 `code` 时由服务端自动生成。

---

## 4. 公开分享（不需要登录）

### `GET /api/s/:code` — 取元数据

```json
{
  "filename": "clean.csv",
  "size": 12345,
  "mime": "text/csv",
  "hasPassword": true,
  "expiresAt": 1730000000000
}
```

### `POST /api/s/:code/verify` — 提交密码

```json
{ "password": "xxx" }
```

响应：

```json
{ "downloadToken": "dt_一次性令牌" }
```

> `downloadToken` 用于下一步实际下载。如果没设密码，**跳过这一步**。

### `GET /api/s/:code/download?token=...` — 下载文件

- 有密码：`token` 来自 `/verify` 响应。
- 无密码：直接 `GET /api/s/:code/download` 即可。

响应是文件流（带 `Content-Disposition: attachment; filename=...`）。

### `GET /s/:code` — **预览页（H5）**

直接在浏览器打开：显示文件名、大小、倒计时，以及"下载"按钮。
**手机/电脑/微信内置浏览器都能用**，这是 DataHub 的核心交付物。

---

## 5. 健康检查

### `GET /healthz`

```json
{ "ok": true, "uptime": 12.3 }
```

---

## 6. 错误码

| HTTP | 含义 |
|---|---|
| 400 | 参数错误 / 文件过大 |
| 401 | 未登录 / token 失效 |
| 403 | 密码错 / 不是文件主人 |
| 404 | 短码不存在 |
| 410 | 已过期 |
| 413 | 文件超过 `MAX_FILE_SIZE_MB` |
| 429 | 触发限流 |
| 500 | 服务器内部错误 |

---

## 7. 端到端示例（用 curl）

> AI 助手可以基于这段模板，**按你的需求改写**（比如换成 Python、JS、PowerShell，或自动填过期时间、自动读本地文件）。

```bash
HOST=http://localhost:3000

# 1) 登录
TOKEN=$(curl -s -X POST $HOST/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"xxx"}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")

# 2) 上传
FILE_ID=$(curl -s -X POST $HOST/api/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./clean.csv" \
  -F "expiresIn=72" \
  -F "password=secret" \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")

# 3) 开分享
curl -X POST $HOST/api/share \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"fileId\":\"$FILE_ID\"}"
# => {"code":"aB3xY","url":"http://localhost:3000/s/aB3xY",...}
```

把返回的 `url` 发给对方即可。

---

## 8. 跟 DataCleanerProAI 的协作模式

```
┌───────────────┐    导出 csv     ┌────────┐  上传  ┌────────┐  短链接  ┌────────┐
│ DataCleaner   │ ───────────────▶│ 本地   │ ─────▶ │ DataHub│ ───────▶ │ 微信/邮件│
│ ProAI (清洗)  │                 │ 落盘   │        │ (存储) │          │         │
└───────────────┘                 └────────┘        └────────┘          └────────┘
       ↑                                                            │
       └──────────── 让 AI 助手写上面那段 curl 脚本 ──────────────────┘
```

**不要**在 DataHub 里复刻 AI 清洗逻辑——直接让 AI 把"清洗结果 → 上传 → 分享"这一步串起来。
具体 prompt 模板见 [`docs/AI_ASSISTANT_PROMPT.md`](./docs/AI_ASSISTANT_PROMPT.md)。