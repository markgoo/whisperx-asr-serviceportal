'use strict';
/** 分析转写文本里的疑似错误模式。 */
const Database = require('better-sqlite3');

const id = Number(process.argv[2] || 13);
const db = new Database('/app/data/portal.db', { readonly: true });
const text = db.prepare('SELECT result_text FROM tasks WHERE id = ?').get(id).result_text;
db.close();

console.log(`全文 ${text.length} 字\n`);

// 1. 句号出现在句中（断句可疑）
const weirdPeriod = [...text.matchAll(/.{6}。.{6}/g)].slice(0, 8);
console.log('=== 句中句号（可疑断句）===');
for (const m of weirdPeriod) console.log(`  …${m[0]}…`);

// 2. 连续重复
const repeat = [...text.matchAll(/(.{2,6})\1{2,}/g)].slice(0, 6);
console.log('\n=== 连续重复 ===');
if (!repeat.length) console.log('  无');
for (const m of repeat) console.log(`  ${m[0].slice(0, 30)}`);

// 3. 极短段落（可能是切碎的）
console.log('\n=== 汉字密度 ===');
const han = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
const latin = (text.match(/[a-zA-Z]/g) || []).length;
const digit = (text.match(/[0-9]/g) || []).length;
const punct = (text.match(/[，。！？；、]/g) || []).length;
console.log(`  汉字 ${han}, 字母 ${latin}, 数字 ${digit}, 标点 ${punct}`);
console.log(`  标点/汉字 = ${(punct / han * 100).toFixed(1)}%（正常中文约 8-12%）`);

// 4. 疑似英文误识别的字母串
console.log('\n=== 文本里的英文片段 ===');
const latinRuns = [...new Set(text.match(/[a-zA-Z]{2,}/g) || [])];
console.log(`  ${latinRuns.length} 种: ${latinRuns.slice(0, 20).join(', ')}`);
