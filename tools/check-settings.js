'use strict';
const Database = require('better-sqlite3');
const db = new Database('/app/data/portal.db', { readonly: true });
const rows = db.prepare('SELECT key, value FROM settings').all();
for (const r of rows) {
  if (/normalize|punc|split/.test(r.key)) console.log(`  ${r.key} = ${r.value}`);
}
db.close();
