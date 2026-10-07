// DataHub dashboard frontend
(function () {
  const API = '/api';
  const TOKEN_KEY = 'datahub_token';
  const USER_KEY = 'datahub_user';

  // ---------- State ----------
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    user: JSON.parse(localStorage.getItem(USER_KEY) || 'null'),
    file: null,
  };

  // ---------- Helpers ----------
  function $(id) { return document.getElementById(id); }
  function authHeader() { return state.token ? { 'Authorization': 'Bearer ' + state.token } : {}; }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
  }

  function escapeHtml(s) {
    const _EAMP = ['&', 'a', 'm', 'p', ';'].join('');
    const _ELT  = ['&', 'l', 't', ';'].join('');
    const _EGT  = ['&', 'g', 't', ';'].join('');
    const _EQUOT= ['&', 'q', 'u', 'o', 't', ';'].join('');
    const _EAPOS= ['&', '#', '3', '9', ';'].join('');
    const _E = {};
    _E[_EAMP] = _EAMP; _E[_ELT] = _ELT; _E[_EGT] = _EGT;
    _E[_EQUOT] = _EQUOT; _E[_EAPOS] = _EAPOS;
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      _E[c === "'" ? _EAPOS : '&' + (c === '<' ? 'lt' : c === '>' ? 'gt' : c === '"' ? 'quot' : 'amp') + ';']
    );
  }

  function fmtSize(b) {
    if (!Number.isFinite(b)) return '-';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }

  function fmtTime(iso) {
    if (iso === null || iso === undefined || iso === '') return '永久有效';
    const d = typeof iso === 'number' ? new Date(iso) : new Date(String(iso).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return iso;
    const now = new Date();
    const diff = (d - now) / 1000;
    if (diff < 0) return '已过期';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟后';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时后';
    return Math.floor(diff / 86400) + ' 天后';
  }

  // ---------- Auth modal ----------
  let authMode = 'login'; // 'login' | 'register'
  function openAuth(mode) {
    authMode = mode;
    $('authTitle').textContent = mode === 'login' ? '登录' : '注册';
    $('authSubmit').textContent = mode === 'login' ? '登录' : '注册';
    $('authSwitch').innerHTML = mode === 'login'
      ? '还没有账号？<a href="#" id="authToggle">去注册</a>'
      : '已有账号？<a href="#" id="authToggle">去登录</a>';
    $('authErr').textContent = '';
    $('authUsername').value = '';
    $('authPassword').value = '';
    $('authModal').hidden = false;
    $('authUsername').focus();
    $('authToggle').onclick = (e) => { e.preventDefault(); openAuth(mode === 'login' ? 'register' : 'login'); };
  }
  function closeAuth() { $('authModal').hidden = true; }

  async function submitAuth() {
    const username = $('authUsername').value.trim();
    const password = $('authPassword').value;
    $('authErr').textContent = '';
    if (!username || !password) { $('authErr').textContent = '请输入用户名和密码'; return; }
    try {
      const r = await fetch(API + '/auth/' + (authMode === 'login' ? 'login' : 'register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { $('authErr').textContent = j.error || '请求失败'; return; }
      if (j.token) {
        state.token = j.token;
        state.user = j.user || { username };
        localStorage.setItem(TOKEN_KEY, state.token);
        localStorage.setItem(USER_KEY, JSON.stringify(state.user));
        closeAuth();
        renderUser();
        refreshFiles();
        toast(authMode === 'login' ? '登录成功' : '注册成功');
      } else {
        $('authErr').textContent = '服务器未返回 token';
      }
    } catch (e) {
      $('authErr').textContent = '网络错误：' + e.message;
    }
  }

  function logout() {
    state.token = null; state.user = null;
    localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY);
    renderUser();
    renderFilesEmpty();
    toast('已退出登录');
  }

  function renderUser() {
    const box = $('userBox');
    if (state.user) {
      box.innerHTML = '<span class="name">👤 ' + escapeHtml(state.user.username) + '</span>' +
        '<button class="btn ghost" id="btnLogout">退出</button>';
      $('btnLogout').onclick = logout;
    } else {
      box.innerHTML = '<button class="btn ghost" id="btnLogin">登录</button>' +
        '<button class="btn" id="btnRegister">注册</button>';
      $('btnLogin').onclick = () => openAuth('login');
      $('btnRegister').onclick = () => openAuth('register');
    }
  }

  // ---------- Files ----------
  function renderFilesEmpty() {
    $('filesBody').innerHTML = '<tr><td colspan="7" class="empty">登录后查看你的文件</td></tr>';
    $('usageInfo').textContent = '登录后查看';
  }

  async function refreshFiles() {
    if (!state.token) { renderFilesEmpty(); return; }
    try {
      const r = await fetch(API + '/files', { headers: authHeader() });
      if (r.status === 401) { logout(); return; }
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data.files || []);
      const quota = data.quota || null;
      const body = $('filesBody');
      if (list.length === 0) {
        body.innerHTML = '<tr><td colspan="7" class="empty">还没有上传过文件</td></tr>';
      } else {
        body.innerHTML = list.map(f => {
          const url = window.location.origin + '/s/' + encodeURIComponent(f.shareCode);
          return '<tr>' +
            '<td class="name">' + escapeHtml(f.originalName) + '</td>' +
            '<td>' + fmtSize(f.fileSize) + '</td>' +
            '<td>' + escapeHtml(f.mimeType || '?') + '</td>' +
            '<td><a href="' + url + '" target="_blank"><code>' + escapeHtml(f.shareCode) + '</code></a></td>' +
            '<td>' + (f.downloadCount || 0) + '</td>' +
            '<td>' + fmtTime(f.expiresAt) + '</td>' +
            '<td class="actions">' +
              '<button class="btn small ghost" data-copy="' + url + '">复制</button>' +
              '<button class="btn small" data-page="' + url + '">预览</button>' +
              '<button class="btn small danger" data-del="' + f.id + '">删除</button>' +
            '</td>' +
          '</tr>';
        }).join('');
        body.querySelectorAll('button[data-copy]').forEach(b => {
          b.onclick = () => copyToClipboard(b.dataset.copy, '已复制分享链接');
        });
        body.querySelectorAll('button[data-page]').forEach(b => {
          b.onclick = () => window.open(b.dataset.page, '_blank');
        });
        body.querySelectorAll('button[data-del]').forEach(b => {
          b.onclick = () => deleteFile(parseInt(b.dataset.del, 10));
        });
      }
      // usage
      if (quota) {
        $('usageInfo').textContent = '已用 ' + fmtSize(quota.used) + ' / ' + fmtSize(quota.max) + ' · 共 ' + list.length + ' 个文件';
      } else {
        const total = list.reduce((s, f) => s + (f.fileSize || 0), 0);
        $('usageInfo').textContent = '已用 ' + fmtSize(total) + ' · 共 ' + list.length + ' 个文件';
      }
    } catch (e) {
      $('filesBody').innerHTML = '<tr><td colspan="7" class="empty">加载失败：' + escapeHtml(e.message) + '</td></tr>';
    }
  }

  async function copyToClipboard(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg || '已复制'); }
    catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(msg || '已复制'); }
      catch (e) { toast('复制失败'); }
      document.body.removeChild(ta);
    }
  }

  async function deleteFile(id) {
    if (!confirm('确认删除这个文件？此操作不可恢复。')) return;
    try {
      const r = await fetch(API + '/files/' + id, { method: 'DELETE', headers: authHeader() });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast(j.error || '删除失败');
        return;
      }
      toast('已删除');
      refreshFiles();
    } catch (e) { toast('网络错误'); }
  }

  // ---------- Upload ----------
  function selectFile(file) {
    if (!file) return;
    state.file = file;
    $('fileInfo').textContent = file.name + ' · ' + fmtSize(file.size);
  }

  async function uploadFile() {
    if (!state.token) { openAuth('login'); toast('请先登录'); return; }
    if (!state.file) { toast('请先选择文件'); return; }
    const fd = new FormData();
    fd.append('file', state.file);
    const pw = $('uploadPassword').value.trim();
    if (pw) fd.append('password', pw);
    const exp = $('uploadExpires').value.trim();
    if (exp !== '') {
      if (!/^\d+$/.test(exp)) { toast('有效期需为非负整数小时（0 = 永久）'); return; }
      fd.append('expiresIn', exp);
    }

    const progress = $('progress');
    const bar = $('progressBar');
    const text = $('progressText');
    progress.hidden = false; bar.style.width = '0%'; text.textContent = '0%';
    $('btnUpload').disabled = true;

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/upload');
      xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round(e.loaded / e.total * 100);
          bar.style.width = p + '%';
          text.textContent = p + '%';
        }
      };
      xhr.onload = () => {
        $('btnUpload').disabled = false;
        progress.hidden = true;
        let j = {}; try { j = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status >= 200 && xhr.status < 300 && j.shareCode) {
          const url = window.location.origin + '/s/' + j.shareCode;
          $('result').hidden = false;
          $('resultLink').href = url;
          $('resultLink').textContent = url;
          $('resultCode').textContent = j.shareCode;
          $('resultExpiry').textContent = '过期：' + (j.expiresAt
            ? new Date(j.expiresAt).toLocaleString()
            : '永久有效');
          $('copyLink').onclick = () => copyToClipboard(url, '已复制分享链接');
          toast('上传成功');
          state.file = null;
          $('fileInfo').textContent = '尚未选择文件';
          $('fileInput').value = '';
          $('uploadPassword').value = '';
          $('uploadExpires').value = '';
          refreshFiles();
        } else {
          toast(j.error || ('上传失败：HTTP ' + xhr.status));
        }
      };
      xhr.onerror = () => { $('btnUpload').disabled = false; progress.hidden = true; toast('网络错误'); };
      xhr.send(fd);
    } catch (e) {
      $('btnUpload').disabled = false;
      progress.hidden = true;
      toast('上传失败：' + e.message);
    }
  }

  // ---------- Init ----------
  function init() {
    renderUser();
    if (state.token) refreshFiles(); else renderFilesEmpty();

    $('btnLogin').onclick = () => openAuth('login');
    $('btnRegister').onclick = () => openAuth('register');
    $('authCancel').onclick = closeAuth;
    $('authSubmit').onclick = submitAuth;
    $('authPassword').onkeydown = (e) => { if (e.key === 'Enter') submitAuth(); };

    const drop = $('dropZone');
    const input = $('fileInput');
    $('pickFile').onclick = (e) => { e.preventDefault(); input.click(); };
    drop.onclick = (e) => { if (e.target.tagName !== 'A') input.click(); };
    input.onchange = (e) => selectFile(e.target.files[0]);
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); drop.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); drop.classList.remove('dragover');
    }));
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) selectFile(f);
    });

    $('btnUpload').onclick = uploadFile;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();