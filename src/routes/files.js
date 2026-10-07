// DataHub - File Routes
// POST   /api/upload              multipart file + auth + optional password -> { shareCode, url, ... }
// GET    /api/files               auth -> list of my files
// GET    /api/files/:id/meta      auth -> single file meta (owner only)
// DELETE /api/files/:id           auth -> delete file (owner only)
// GET    /api/s/:code             public -> { name, size, mime, hasPassword, ... } (does NOT download)
// POST   /api/s/:code/verify      { password } -> { token } (short-lived, used to authorize download)
// GET    /api/s/:code/download?token=... or with header -> stream file

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { customAlphabet } = require('nanoid');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const config = require('../config');
const { authRequired } = require('../middleware/auth');
const { cleanExpired } = require('../jobs/cleanup');

const router = express.Router();

// Ensure storage dir exists
fs.mkdirSync(config.storage.dir, { recursive: true });

// -- Share-code generator (8 chars, URL safe) --
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 8);
const newShareCode = () => nanoid();

// -- File storage on disk: <stored_name> = <share_code>.<ext-or-bin> --
function storedFilenameFor(shareCode, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  return `${shareCode}${ext || '.bin'}`;
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

// -- multer setup: store on disk, deterministic name --
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.storage.dir),
  filename: (req, file, cb) => {
    // We rename to share_code after we get it; multer needs an initial name.
    cb(null, `tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.storage.maxFileSizeMB * 1024 * 1024 },
});

// -- Rate limiter for public share endpoints --
const shareLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' },
});

// -- Helpers --
function userQuotaUsed(userId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(file_size), 0) AS used FROM files WHERE user_id = ?')
    .get(userId);
  return row.used || 0;
}

function publicFileMeta(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    shareCode: row.share_code,
    hasPassword: !!row.password_hash,
    downloadCount: row.download_count,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

// ============================================================
// Authenticated upload
// ============================================================
router.post('/upload', authRequired, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File exceeds ${config.storage.maxFileSizeMB}MB limit` });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
  }

  const { originalname, size, mimetype, path: tmpPath } = req.file;
  const wantsPassword = req.body && req.body.password ? String(req.body.password) : null;

  // Quota check
  const used = userQuotaUsed(req.user.id);
  const quotaBytes = config.storage.maxUserQuotaMB * 1024 * 1024;
  if (used + size > quotaBytes) {
    safeUnlink(tmpPath);
    return res.status(413).json({
      error: `User quota exceeded (${config.storage.maxUserQuotaMB}MB). Used ${(used / 1024 / 1024).toFixed(2)}MB.`,
    });
  }

  // Generate unique share code
  let shareCode;
  for (let i = 0; i < 5; i++) {
    shareCode = newShareCode();
    const exists = db.prepare('SELECT 1 FROM files WHERE share_code = ?').get(shareCode);
    if (!exists) break;
    shareCode = null;
  }
  if (!shareCode) {
    safeUnlink(tmpPath);
    return res.status(500).json({ error: 'Could not generate unique share code' });
  }

  // Rename tmp file to final name based on share code
  const finalName = storedFilenameFor(shareCode, originalname);
  const finalPath = path.join(config.storage.dir, finalName);
  try {
    await fsp.rename(tmpPath, finalPath);
  } catch (e) {
    safeUnlink(tmpPath);
    return res.status(500).json({ error: 'Failed to persist file' });
  }

  // Hash password if provided
  const passwordHash = wantsPassword ? await bcrypt.hash(wantsPassword, 10) : null;

  // Expiry
  const expiresAt = new Date(Date.now() + config.storage.linkExpiryDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  try {
    const info = db.prepare(`
      INSERT INTO files (user_id, original_name, stored_name, file_size, mime_type, share_code, password_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      originalname,
      finalName,
      size,
      mimetype || 'application/octet-stream',
      shareCode,
      passwordHash,
      expiresAt
    );

    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(info.lastInsertRowid);
    const shareUrl = `${config.baseUrl}/s/${shareCode}`;

    res.status(201).json({
      ...publicFileMeta(row),
      shareUrl,
    });
  } catch (e) {
    safeUnlink(finalPath);
    return res.status(500).json({ error: 'DB insert failed: ' + e.message });
  }
});

// ============================================================
// List my files
// ============================================================
router.get('/files', authRequired, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json({
    files: rows.map(publicFileMeta),
    quota: {
      used: userQuotaUsed(req.user.id),
      max: config.storage.maxUserQuotaMB * 1024 * 1024,
    },
  });
});

// ============================================================
// Delete one of my files
// ============================================================
router.delete('/files/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  const row = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'file not found' });

  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  safeUnlink(path.join(config.storage.dir, row.stored_name));

  res.json({ success: true });
});

// ============================================================
// Public: get share metadata (no download)
// ============================================================
router.get('/s/:code', shareLimiter, (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE share_code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ error: '分享链接不存在' });

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    // lazy cleanup
    db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    safeUnlink(path.join(config.storage.dir, row.stored_name));
    return res.status(410).json({ error: '分享链接已过期' });
  }

  res.json({
    name: row.original_name,
    size: row.file_size,
    mime: row.mime_type,
    hasPassword: !!row.password_hash,
    expiresAt: row.expires_at,
    downloadCount: row.download_count,
    previewable: isPreviewable(row.mime_type, row.original_name),
  });
});

// ============================================================
// Public: verify password -> get short-lived download token
// ============================================================
router.post('/s/:code/verify', shareLimiter, async (req, res) => {
  const { password } = req.body || {};
  const row = db.prepare('SELECT * FROM files WHERE share_code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ error: '分享链接不存在' });
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ error: '分享链接已过期' });
  }
  if (!row.password_hash) {
    return res.json({ token: null, message: 'no password set' });
  }
  if (!password) return res.status(400).json({ error: '需要密码' });

  const ok = await bcrypt.compare(String(password), row.password_hash);
  if (!ok) return res.status(401).json({ error: '密码错误' });

  const token = jwt.sign(
    { code: row.share_code, scope: 'download' },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
  res.json({ token });
});

// ============================================================
// Public: download (increments counter, requires password token if protected)
// ============================================================
router.get('/s/:code/download', shareLimiter, async (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE share_code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ error: '分享链接不存在' });
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ error: '分享链接已过期' });
  }

  // If password protected, require download token (header or query)
  if (row.password_hash) {
    const token =
      (req.headers['x-download-token'] ||
        (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        req.query.token);
    if (!token) return res.status(401).json({ error: '需要密码' });
    try {
      const payload = jwt.verify(token, config.jwt.secret);
      if (payload.code !== row.share_code || payload.scope !== 'download') {
        return res.status(401).json({ error: 'invalid token' });
      }
    } catch (_) {
      return res.status(401).json({ error: 'invalid or expired token' });
    }
  }

  // Preview? If Accept includes text/html and the type is previewable, render preview page.
  const wantsPreview = isPreviewable(row.mime_type, row.original_name) &&
    (req.query.preview === '1' || (req.headers.accept || '').includes('text/html'));

  const filePath = path.join(config.storage.dir, row.stored_name);
  if (!fs.existsSync(filePath)) {
    return res.status(410).json({ error: '文件已被删除' });
  }

  // Bump counter (best-effort)
  try { db.prepare('UPDATE files SET download_count = download_count + 1 WHERE id = ?').run(row.id); } catch (_) {}

  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', row.file_size);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(row.original_name)}"`
  );

  if (wantsPreview) {
    // For preview, return inline
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.original_name)}"`);
  }

  fs.createReadStream(filePath).pipe(res);
});

// Public preview page (HTML) - served if client visits /s/:code in browser
router.get('/s/:code/page', shareLimiter, (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE share_code = ?').get(req.params.code);
  if (!row) {
    return res.status(404).send(renderErrorPage('分享链接不存在', 404));
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return res.status(410).send(renderErrorPage('分享链接已过期', 410));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderSharePage(row, config.baseUrl));
});

// -- helpers --
function isPreviewable(mime, name) {
  if (!mime && !name) return false;
  const m = (mime || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (m.startsWith('text/') || m === 'application/json') return true;
  if (m === 'text/csv' || n.endsWith('.csv')) return true;
  if (m === 'application/vnd.ms-excel' || m.includes('spreadsheetml')) return true;
  return false;
}

function renderErrorPage(msg, code) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DataHub · ${code}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .box{background:#1e293b;padding:32px 40px;border-radius:12px;max-width:480px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  h1{color:#f87171;margin:0 0 12px} p{color:#cbd5e1;margin:0} a{color:#60a5fa;text-decoration:none}</style>
  </head><body><div class="box"><h1>${code}</h1><p>${msg}</p><p style="margin-top:16px"><a href="/">返回首页</a></p></div></body></html>`;
}

function renderSharePage(row, baseUrl) {
  const isProtected = !!row.password_hash;
  const isPreview = isPreviewable(row.mime_type, row.original_name);
  const ext = path.extname(row.original_name).toLowerCase();
  const fileSizeHuman = humanSize(row.file_size);
  const expiresHuman = new Date(row.expires_at).toLocaleString('zh-CN');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DataHub · 分享文件 - ${escapeHtml(row.original_name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f172a;--card:#1e293b;--line:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#60a5fa;--accent2:#22d3ee;--ok:#34d399;--warn:#fbbf24;--err:#f87171}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:linear-gradient(180deg,#0b1224 0%,#0f172a 100%);color:var(--text);min-height:100vh}
.wrap{max-width:980px;margin:0 auto;padding:32px 20px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px}
.logo .dot{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#60a5fa,#22d3ee);display:flex;align-items:center;justify-content:center;color:#0b1224;font-weight:800}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.row{display:flex;flex-wrap:wrap;gap:24px}
.col{flex:1;min-width:280px}
h2{margin:0 0 8px;font-size:22px}
h3{margin:0 0 8px;font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.kv{display:grid;grid-template-columns:120px 1fr;gap:8px 16px;margin-top:8px}
.kv div:nth-child(odd){color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
button,a.btn{appearance:none;border:0;cursor:pointer;font-size:14px;padding:10px 16px;border-radius:10px;font-weight:600;text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:transform .08s}
.btn-primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#0b1224}
.btn-secondary{background:#334155;color:#e2e8f0}
.btn-ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
button:active,a.btn:active{transform:scale(.98)}
input[type=password]{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:#0b1224;color:var(--text);font-size:14px}
.locked{padding:18px;border:1px dashed var(--line);border-radius:12px;background:#0b1224}
.muted{color:var(--muted);font-size:13px}
.preview{margin-top:24px;background:#0b1224;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.preview .ph{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.preview .pb{max-height:540px;overflow:auto;padding:14px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #1f2a44;padding:6px 10px;text-align:left;white-space:nowrap}
th{background:#15203a;position:sticky;top:0}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.5}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#0b1224;border:1px solid var(--line);color:var(--text);padding:10px 16px;border-radius:10px;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.show{opacity:1}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--muted)}
.badge.ok{color:#0b1224;background:var(--ok);border-color:transparent}
.badge.warn{color:#0b1224;background:var(--warn);border-color:transparent}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo"><div class="dot">D</div> DataHub · 分享文件</div>
    <a class="btn btn-ghost" href="/">+ 创建分享</a>
  </header>

  <div class="card">
    <h2 id="fileName">${escapeHtml(row.original_name)}</h2>
    <div class="muted">
      <span class="badge">${ext || '文件'}</span>
      <span class="badge">${fileSizeHuman}</span>
      <span class="badge" id="dlBadge">下载 ${row.download_count} 次</span>
      <span class="badge warn">${expiresHuman} 到期</span>
    </div>

    <div class="row" style="margin-top:20px">
      <div class="col">
        <h3>文件信息</h3>
        <div class="kv">
          <div>分享码</div><div><code id="shareCode">${row.share_code}</code></div>
          <div>下载次数</div><div id="dlCount">${row.download_count}</div>
          <div>到期时间</div><div>${expiresHuman}</div>
          <div>MIME</div><div class="muted">${escapeHtml(row.mime_type || 'application/octet-stream')}</div>
        </div>

        <h3 style="margin-top:20px">分享链接</h3>
        <div class="actions">
          <button class="btn btn-primary" id="copyBtn">📋 复制分享链接</button>
          <a class="btn btn-secondary" id="dlBtn" href="/api/s/${row.share_code}/download">⬇ 直接下载</a>
        </div>
        <div class="muted" style="margin-top:6px">${isProtected ? '🔒 此文件受密码保护' : '🔓 公开下载'}</div>
      </div>

      <div class="col" id="authCol">
        ${isProtected ? `
          <h3>访问密码</h3>
          <div class="locked">
            <p class="muted" style="margin:0 0 10px">请输入密码以解锁下载</p>
            <input type="password" id="pwInput" placeholder="密码">
            <div class="actions">
              <button class="btn btn-primary" id="pwBtn">解锁</button>
            </div>
            <div class="muted" id="pwMsg" style="margin-top:8px"></div>
          </div>
        ` : `
          <h3>提示</h3>
          <p class="muted">此文件没有密码保护。任何持有链接的人都可以下载。</p>
        `}
      </div>
    </div>

    ${isPreview ? `
    <div class="preview">
      <div class="ph">📄 在线预览 · ${ext} · 仅展示前 5MB / 200 行</div>
      <div class="pb" id="previewBody"><div class="muted">加载中...</div></div>
    </div>
    ` : ''}
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(function(){
  const code = ${JSON.stringify(row.share_code)};
  const hasPw = ${isProtected ? 'true' : 'false'};
  const isPreview = ${isPreview ? 'true' : 'false'};
  const link = ${JSON.stringify(baseUrl + '/s/' + row.share_code)};
  const apiBase = '/api';

  function showToast(msg){
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'), 1800);
  }
  document.getElementById('copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); showToast('已复制分享链接'); }
    catch(_){
      const ta = document.createElement('textarea'); ta.value = link; document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); showToast('已复制分享链接'); }catch(e){ showToast('复制失败'); }
      document.body.removeChild(ta);
    }
  });

  // Download: if protected, ask password first
  const dlBtn = document.getElementById('dlBtn');
  if (dlBtn){
    dlBtn.addEventListener('click', async (e) => {
      if (!hasPw) return; // normal anchor
      e.preventDefault();
      const pw = prompt('请输入访问密码');
      if (!pw) return;
      try {
        const r = await fetch(apiBase + '/s/' + code + '/verify', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password: pw})});
        if (!r.ok){ const j = await r.json().catch(()=>({})); alert(j.error || '密码错误'); return; }
        const j = await r.json();
        if (j.token){
          window.location.href = apiBase + '/s/' + code + '/download?token=' + encodeURIComponent(j.token);
        }
      } catch(err){ alert('网络错误'); }
    });
  }

  if (hasPw){
    const pwBtn = document.getElementById('pwBtn');
    if (pwBtn){
      pwBtn.addEventListener('click', async () => {
        const v = document.getElementById('pwInput').value;
        const msg = document.getElementById('pwMsg');
        if (!v){ msg.textContent = '请输入密码'; return; }
        msg.textContent = '验证中...';
        try {
          const r = await fetch(apiBase + '/s/' + code + '/verify', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password: v})});
          const j = await r.json().catch(()=>({}));
          if (!r.ok){ msg.textContent = j.error || '密码错误'; return; }
          msg.textContent = '✓ 密码正确，正在准备下载...';
          if (j.token){
            window.location.href = apiBase + '/s/' + code + '/download?token=' + encodeURIComponent(j.token);
          }
        } catch(e){ msg.textContent = '网络错误'; }
      });
    }
  }

  // Preview
  if (isPreview){
    fetchPreview();
  }
  async function fetchPreview(){
    const body = document.getElementById('previewBody');
    try {
      // For CSV/JSON, we can use the public download endpoint (no password), since preview is read-only.
      // If protected, require password.
      let url = apiBase + '/s/' + code + '/download?preview=1';
      if (hasPw){
        const pw = prompt('预览需要先输入访问密码');
        if (!pw){ body.innerHTML = '<div class="muted">已取消预览</div>'; return; }
        const r = await fetch(apiBase + '/s/' + code + '/verify', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password: pw})});
        const j = await r.json().catch(()=>({}));
        if (!r.ok || !j.token){ body.innerHTML = '<div class="muted">密码错误，无法预览</div>'; return; }
        url += '&token=' + encodeURIComponent(j.token);
      }
      const r = await fetch(url);
      if (!r.ok){ body.innerHTML = '<div class="muted">无法加载预览</div>'; return; }
      const text = (await r.text()).slice(0, 5 * 1024 * 1024);
      const ext = (${JSON.stringify(ext)} || '').toLowerCase();
      const mime = (${JSON.stringify(row.mime_type || '')}).toLowerCase();
      if (ext === '.csv' || mime === 'text/csv' || mime.startsWith('text/')){
        renderCSV(text);
      } else {
        // json
        try { const obj = JSON.parse(text); renderTable(obj); } catch(_){ body.innerHTML = '<pre>'+escape(text)+'</pre>'; }
      }
    } catch(e){ body.innerHTML = '<div class="muted">预览失败</div>'; }
  }
  // escape() is defined in a way that the editor formatter cannot accidentally
  // decode the entity tokens (no `&` followed by an entity name ever appears literally in source).
  function escape(s){
    const A = ['&','a','m','p',';'].join('');
    const L = ['&','l','t',';'].join('');
    const G = ['&','g','t',';'].join('');
    const map = {}; map['&']=A; map['<']=L; map['>']=G;
    return s.replace(/[&<>]/g, c => map[c]);
  }
  function renderCSV(text){
    const lines = text.split(/\\r?\\n/).slice(0, 200);
    if (!lines.length){ body.innerHTML = '<div class="muted">空文件</div>'; return; }
    const parse = (line) => {
      const out=[]; let cur=''; let q=false;
      for (let i=0;i<line.length;i++){const c=line[i];
        if (q){ if (c==='"'){ if (line[i+1]==='"'){cur+='"';i++;} else q=false;} else cur+=c; }
        else { if (c==='"') q=true; else if (c===','){out.push(cur);cur='';} else cur+=c; }
      } out.push(cur); return out;
    };
    const head = parse(lines[0]);
    let html = '<table><thead><tr>' + head.map(h=>'<th>'+escape(h)+'</th>').join('') + '</tr></thead><tbody>';
    for (let i=1;i<lines.length;i++){ if(!lines[i]) continue; const row = parse(lines[i]); html += '<tr>' + row.map(c=>'<td>'+escape(c)+'</td>').join('') + '</tr>'; }
    html += '</tbody></table>';
    body.innerHTML = html;
  }
  function renderTable(obj){
    let arr = Array.isArray(obj) ? obj : (Array.isArray(obj.data) ? obj.data : null);
    if (!arr || !arr.length || typeof arr[0] !== 'object'){
      body.innerHTML = '<pre>'+escape(JSON.stringify(obj, null, 2))+'</pre>'; return;
    }
    const keys = Array.from(new Set(arr.flatMap(o => Object.keys(o))));
    let html = '<table><thead><tr>' + keys.map(k=>'<th>'+escape(k)+'</th>').join('') + '</tr></thead><tbody>';
    for (const o of arr){ html += '<tr>' + keys.map(k=>'<td>'+escape(String(o[k] ?? ''))+'</td>').join('') + '</tr>'; }
    html += '</tbody></table>';
    body.innerHTML = html;
  }
})();
</script>
</body></html>`;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// Build an entity-escape function whose source is free of HTML entity syntax,
// so editor formatters can't accidentally decode them.
const _EAMP = ['&','a','m','p',';'].join('');
const _ELT  = ['&','l','t',';'].join('');
const _EGT  = ['&','g','t',';'].join('');
const _EQUOT= ['&','q','u','o','t',';'].join('');
const _EAPOS= ['&','#','3','9',';'].join('');
const _E = { [_EAMP]:_EAMP, [_ELT]:_ELT, [_EGT]:_EGT, [_EQUOT]:_EQUOT, [_EAPOS]:_EAPOS };
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => _E[c === "'" ? _EAPOS : '&' + (c === '<' ? 'lt' : c === '>' ? 'gt' : c === '"' ? 'quot' : 'amp') + ';']);
}

module.exports = router;