# DataHub API

DataHub 是一个**极简的"上传 → 立刻得到可分享短链接"** 的 HTTP 后端。
它不解析文件内容、不做 AI 清洗、不做格式转换——只负责**存**和**发**。

清洗 / 转换在本地工具（`DataCleanerProAI` 等）里完成；**让 AI 助手**把两者粘起来。详见 [`docs/AI_ASSISTANT_PROMPT.md`](./docs/AI_ASSISTANT_PROMPT.md) 与 [README.md](./README.md)。

---

## 通用约定

- Base URL：`http://localhost:3000`（默认），可通过 `BASE_URL` 环境变量修改，响应里的 `shareUrl` 会自动用它拼接。
- 鉴权：除注册/登录、公开分享接口（`/api/s/...`、`/s/...`）外，需要在 header 里带 `Authorization: Bearer <token>`。
- Content-Type：
  - JSON 请求 → `application/json`
  - 文件上传 → `multipart/form-data`（文件字段名必须是 `file`）
- 错误格式：`{ "error": "..." }`。
- 时间字段：JSON 里的 `expiresAt` 一律是 **epoch 毫秒数**；`null` 表示**永不过期**。
- 短链接码：默认服务端生成 8 位 `[A-Za-z0-9]`；也可以在上传时用 `code` 字段自定义 4–32 位 `[A-Za-z0-9_-]`。

---

## 1. 账号

账号体系是**用户名 + 密码**（不是邮箱）。用户名 3–32 位 `[a-zA-Z0-9_]`，密码至少 6 位。

### `POST /api/auth/register`

```json
{ "username": "alice", "password": "secret123" }
```

`201` 响应：

```json
{
  "token": "eyJ...",
  "user": { "id": 1, "username": "alice", "createdAt": "2026-10-08 10:00:00" }
}
```

### `POST /api/auth/login`

```json
{ "username": "alice", "password": "secret123" }
```

`200` 响应结构同上。注册/登录同 IP 有暴力破解限流（默认 15 分钟 20 次）。

### `GET /api/auth/me`（需登录）

```json
{ "user": { "id": 1, "username": "alice", "createdAt": "..." } }
```

---

## 2. 上传文件（需登录）—— 上传成功即返回短链接

### `POST /api/upload` — `multipart/form-data`

| 字段 | 必填 | 说明 |
|---|---|---|
| `file` | ✅ | 文件本体（字段名必须是 `file`） |
| `password` | ❌ | 访问密码；设置后访客必须先验密才能下载/预览 |
| `expiresIn` | ❌ | 有效期，**整数小时**；`0` = 永不过期；留空走服务端默认 `LINK_EXPIRY_DAYS`（7 天） |
| `code` | ❌ | 自定义短码，4–32 位 `[A-Za-z0-9_-]`；被占用返回 409 |

`201` 响应：

```json
{
  "id": 42,
  "originalName": "clean.csv",
  "fileSize": 12345,
  "mimeType": "text/csv",
  "shareCode": "aB3xY9kQ",
  "hasPassword": false,
  "downloadCount": 0,
  "expiresAt": 1730000000000,
  "createdAt": "2026-10-08 10:00:00",
  "shareUrl": "http://localhost:3000/s/aB3xY9kQ"
}
```

> **没有单独的"开分享"接口**：文件一上传就已经有短链接，把 `shareUrl` 直接发给别人即可。

### `GET /api/files` — 列出自己的文件（需登录）

```json
{
  "files": [
    {
      "id": 42,
      "originalName": "clean.csv",
      "fileSize": 12345,
      "mimeType": "text/csv",
      "shareCode": "aB3xY9kQ",
      "hasPassword": false,
      "downloadCount": 3,
      "expiresAt": 1730000000000,
      "createdAt": "2026-10-08 10:00:00"
    }
  ],
  "quota": { "used": 12345, "max": 104857600 }
}
```

### `GET /api/files/:id/meta` — 单个文件元数据（需登录，仅主人）

### `DELETE /api/files/:id` — 删除磁盘文件与记录（需登录，仅主人）

---

## 3. 公开分享（不需要登录）

### `GET /api/s/:code` — 取元数据（不下载文件）

```json
{
  "name": "clean.csv",
  "size": 12345,
  "mime": "text/csv",
  "hasPassword": true,
  "expiresAt": 1730000000000,
  "downloadCount": 3,
  "previewable": true
}
```

`previewable` 为 `true` 的文本/CSV/JSON 文件可在分享页里直接在线预览前 5MB / 200 行。

### `POST /api/s/:code/verify` — 提交密码

```json
{ "password": "xxx" }
```

成功响应：

```json
{ "token": "eyJ..." }
```

`token` 是 5 分钟内一次性有效的下载令牌（JWT）。如果该文件没设密码，返回 `{ "token": null, "message": "no password set" }`，此时**跳过这一步**直接下载即可。

### `GET /api/s/:code/download?token=...` — 下载文件

- 无密码：直接 `GET /api/s/:code/download`。
- 有密码：带上 `/verify` 返回的 `token`，放 query（`?token=`）、`X-Download-Token` 头或 `Authorization: Bearer` 头都可以。
- 浏览器以 `text/html` 访问且文件可预览时会以 `inline` 方式展示；普通调用返回 `Content-Disposition: attachment` 文件流。

### `GET /s/:code` — **预览页（H5）**

直接在浏览器打开：文件名、大小、到期时间、下载次数、复制链接按钮、密码解锁与在线预览。
**手机/电脑/微信内置浏览器都能用**，这是 DataHub 的核心交付物。

---

## 4. 健康检查

### `GET /healthz`

```json
{ "ok": true, "uptime": 12.3 }
```

---

## 5. 错误码

| HTTP | 含义 |
|---|---|
| 400 | 参数错误（缺文件、有效期不是非负整数、短码格式不对等） |
| 401 | 未登录 / token 失效 / 下载密码缺失或错误 |
| 404 | 短码或文件不存在 |
| 409 | 用户名已存在 / 自定义短码已被占用 |
| 410 | 分享已过期（或物理文件已被清理） |
| 413 | 文件超过 `MAX_FILE_SIZE_MB`（默认 10MB） |
| 429 | 触发限流 |
| 500 | 服务器内部错误 |

另外：单用户总容量默认 100MB（`MAX_USER_QUOTA_MB`），超限时上传返回 400。

---

## 6. 端到端示例（用 curl）

> AI 助手可以基于这段模板，**按你的需求改写**（Python、JS、PowerShell 都行）。

```bash
HOST=http://localhost:3000

# 1) 注册（已有账号就改成 /api/auth/login）
TOKEN=$(curl -s -X POST $HOST/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")

# 2) 上传 + 直接拿到短链接（72 小时过期、带密码、自定义短码）
curl -s -X POST $HOST/api/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./clean.csv" \
  -F "expiresIn=72" \
  -F "password=secret" \
  -F "code=clean01"
# => {"shareCode":"clean01","shareUrl":"http://localhost:3000/s/clean01", ...}

# 3) 访客：取元数据 → 验密拿 token → 下载
curl -s $HOST/api/s/clean01
curl -s -X POST $HOST/api/s/clean01/verify \
  -H "Content-Type: application/json" \
  -d '{"password":"secret"}'
curl -OJ "$HOST/api/s/clean01/download?token=<上一步的token>"
```

把第 2 步返回的 `shareUrl` 发给对方即可。仓库根目录还附带一个 [`share.sh`](./share.sh) 一行流脚本。

---

## 7. 跟 DataCleanerProAI 的协作模式

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