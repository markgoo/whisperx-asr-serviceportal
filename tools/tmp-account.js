'use strict';
/** 创建/删除临时管理员账号，用于自动化测试。 */
const Database = require('better-sqlite3');
const { hashPassword } = require('../dist/server/password.js');

const USERNAME = '__tmp_verify';
const PASSWORD = 'tmp-verify-2026';
const action = process.argv[2] || 'create';

const db = new Database('data/portal.db');
const now = new Date().toISOString();

db.prepare('DELETE FROM users WHERE username = ?').run(USERNAME);

if (action === 'remove') {
  console.log('临时账号已删除');
} else {
  db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'superadmin', 'active', ?, ?)`,
  ).run(USERNAME, '临时验证', hashPassword(PASSWORD), now, now);
  console.log(`已创建临时账号：${USERNAME} / ${PASSWORD}`);
}
db.close();
