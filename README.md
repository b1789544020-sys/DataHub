# DataHub

> **云端文件 + 可分享短链接**，专门用来把本地工具（DataCleanerProAI、ChartForge、TableSniffer …）的产物**扔上云、生成短链接、发给任何人**。
>
> DataHub 本身**不做**任何 AI 清洗 / 转换 / 解析。清洗活儿交给 `DataCleanerProAI`（或别的工具）去干；当用户想"洗完直接分享"时，**让 AI 助手**（Claude / ChatGPT / …）把两个工具粘起来。

---

## 它能干什么

- 📤 **上传**：注册账号 → `POST /api/upload` 拿到 `fileId`。
- 🔗 **生成可分享短链接**：`POST /api/share` → `{ "code": "aB3xY", "url": "http://host/s/aB3xY" }`。
- 🔒 **可选密码** / ⏰ **可选过期时间**。
- 👀 **预览页**：`/s/:code` 打开就是带下载按钮的 H5 页（手机/电脑/微信都能开）。
- 🗑️ **管理**：`GET /api/files` 列表、`DELETE /api/files/:id` 删除。
- ⏱️ **自动清理**：过期文件由 cron 每小时清一次（`STORAGE_DIR` / `DB_PATH`）。

完整接口见 [API.md](./API.md)。

---

## 快速开始

```bash
cd DataHub
cp .env.example .env          # 改 JWT_SECRET、ADMIN_PASSWORD
npm install
npm run init-db               # 建表 + 默认 admin
npm start                     # http://localhost:3000
```

也可以 Docker：

```bash
docker compose up -d
```

健康检查：

```bash
curl http://localhost:3000/healthz
# => {"ok":true,...}
```

---

## 工作流（典型用法）

```
[本地工具] --导出文件--> [DataHub] --返回短链接--> [用户发给任何人]
   ↑                                                    ↓
   └────────── 让 AI 助手生成 curl/代码 ────────────────┘
```

### 例子 1：DataCleanerProAI 洗完直接分享

1. 打开 DataCleanerProAI，把 `dirty.csv` 洗干净，导出 `clean.csv`。
2. 把 `clean.csv` 交给 AI 助手，让它生成下面的脚本（见 [AI_ASSISTANT_PROMPT.md](./docs/AI_ASSISTANT_PROMPT.md)）：

```bash
# AI 助手生成的命令（可直接复制）
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"xxx"}'
# 拿到 token

curl -X POST http://localhost:3000/api/upload \
  -H "Authorization: Bearer <TOKEN>" \
  -F "file=@/path/to/clean.csv" \
  -F "expiresIn=72" \
  -F "password=optional"
# 拿到 fileId

curl -X POST http://localhost:3000/api/share \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"fileId":"<FILE_ID>","password":"optional","expiresIn":72}'
# 拿到 {"code":"aB3xY","url":"http://host/s/aB3xY"}
```

3. 把 `http://host/s/aB3xY` 发到微信 / 邮件 / 任何地方，对方点开就是预览页，点"下载"拿文件。

### 例子 2：纯命令行一行流

```bash
# 注册 & 登录 & 上传 & 分享 全部由 AI 生成的脚本一次跑完
bash share.sh /path/to/clean.csv
```

---

## 🤖 AI 助手：让 AI 帮你写调用代码

DataHub 的设计哲学是：**自己不写胶水，让 AI 写**。

把 [`docs/AI_ASSISTANT_PROMPT.md`](./docs/AI_ASSISTANT_PROMPT.md) 喂给任意 AI 助手（Claude / ChatGPT / Gemini / Kimi / Qwen …），它就知道：

- DataHub 的全部接口
- 怎么从你的工具里取出文件
- 怎么注册 / 登录 / 拿 token
- 怎么上传、怎么开分享、怎么设密码、怎么定过期
- 出错时怎么提示用户

用户**只要用自然语言说**：

> "把我刚才清洗的 `clean.csv` 传到 DataHub，给我一个 24 小时过期、带密码 `123` 的分享链接"

AI 就会**自己写好脚本、自己执行、把链接返回给你**。

👉 详见 [`docs/AI_ASSISTANT_PROMPT.md`](./docs/AI_ASSISTANT_PROMPT.md)。

---

## 与桌面其他工具的关系

| 工具 | 干什么 | 是否要 AI 清洗 |
|---|---|---|
| **DataHub**（本项目） | 云端 + 分享链接 | ❌ 纯存储 |
| **DataCleanerProAI** | 浏览器内 AI 清洗 | ✅ 本身带 AI |
| **ChartForge** | 数据可视化 | ❌ |
| **TableSniffer** | 网页抓表 | ❌ |
| **SnapMark** | 网页截图标注 | ❌ |

DataHub 跟 **DataCleanerProAI** 是天生一对：一个负责"洗干净"，一个负责"发出去"。中间的"上传"操作不需要你自己写代码，**让 AI 帮你写**。

---

## 项目结构

```
DataHub/
├── src/
│   ├── app.js              # Express 入口
│   ├── config.js           # 读 .env
│   ├── db.js               # SQLite (better-sqlite3)
│   ├── middleware/auth.js  # JWT 校验
│   ├── routes/
│   │   ├── auth.js         # /api/auth/{register,login}
│   │   └── files.js        # /api/upload, /api/files, /api/share, /api/s/:code/...
│   └── jobs/cleanup.js     # cron 清过期
├── public/                 # 自带的极简 Web UI
├── data/                   # 运行时生成（uploads + datahub.db）
├── docs/
│   └── AI_ASSISTANT_PROMPT.md   # 喂给 AI 的 prompt 模板
├── API.md                  # 完整接口文档
├── docker-compose.yml
├── Dockerfile
├── package.json
└── .env.example
```

---

## 常见问题

**Q: 我已经有了别的网盘/对象存储，为什么还要 DataHub？**
A: DataHub 的价值在**短链接 + 预览页**。发一个 5 字符的 `http://host/s/aB3xY` 永远比发一长串 OSS 签名 URL 简单，对方打开就是个带下载按钮的网页（不是二进制流），并且**自动过期**。

**Q: DataHub 能不能也做 AI 清洗？**
A: **不能。** 这是有意为之。AI 清洗交给 `DataCleanerProAI`（已带 AI），DataHub 只管"存 + 发"。要合并两个工具的功能就让 AI 写胶水代码，不要在 DataHub 里重新发明轮子。

**Q: 怎么跟 Nginx / 域名配合？**
A: 把 `BASE_URL` 改成你的域名（如 `https://hub.example.com`），生成的短链接就自动用这个域名。

---

## License

MIT