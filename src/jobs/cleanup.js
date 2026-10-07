// DataHub - Cleanup job
// Deletes expired files (both DB rows and physical files on disk).
// Called from cron in app.js, and also imported (not used yet, but kept for tests).

const path = require('path');
const fs = require('fs');

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} storageDir
 * @returns {number} count of removed files
 */
function cleanExpired(db, storageDir) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const rows = db
    .prepare('SELECT id, stored_name FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .all(now);

  let count = 0;
  const del = db.prepare('DELETE FROM files WHERE id = ?');
  for (const r of rows) {
    try {
      del.run(r.id);
      safeUnlink(path.join(storageDir, r.stored_name));
      count++;
    } catch (e) {
      console.error('[cleanup] failed to remove', r.id, e.message);
    }
  }
  return count;
}

module.exports = { cleanExpired };