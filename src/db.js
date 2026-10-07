// DataHub - SQLite Database Setup
// Uses better-sqlite3 (synchronous, fast, zero-config).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

// Ensure storage directory exists
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const db = new Database(config.db.path);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT,
    share_code TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    download_count INTEGER DEFAULT 0,
    -- NULL means the share never expires
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
  CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
`);

module.exports = db;