/**
 * 端到端冒烟测试：登录、建用户、上传转写、权限隔离、存储清理。
 *
 * 用法：node tools/smoke-test.js [baseUrl]
 * 前置：门户已在 baseUrl 运行，且 data/portal.db 里是默认 admin/admin123。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
let failures = 0;

function ok(name, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

class Client {
  constructor() {
    this.cookie = '';
  }
  async req(path, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (this.cookie) headers.Cookie = this.cookie;
    if (init.body && !(init.body instanceof FormData) && typeof init.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m && m[2]) this.cookie = `${m[1]}=${m[2]}`;
      else if (m && !m[2]) this.cookie = '';
    }
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, text };
  }
  get(p) {
    return this.req(p);
  }
  post(p, body) {
    return this.req(p, { method: 'POST', body });
  }
  patch(p, body) {
    return this.req(p, { method: 'PATCH', body });
  }
  del(p) {
    return this.req(p, { method: 'DELETE' });
  }
  put(p, body) {
    return this.req(p, { method: 'PUT', body });
  }
}

function makeWav(seconds = 1) {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 8000), 44 + i * 2);
  }
  return buf;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`\n== 门户端到端测试 ${BASE} ==\n`);

  // ---------------------------------------------------------------- 认证
  console.log('[1] 认证');
  const anon = new Client();
  ok('未登录访问 /api/tasks 返回 401', (await anon.get('/api/tasks')).status === 401);
  ok('错误密码登录失败', (await new Client().post('/api/auth/login', { username: 'admin', password: 'wrong' })).status === 401);

  const admin = new Client();
  const login = await admin.post('/api/auth/login', { username: 'admin', password: 'admin123' });
  ok('管理员登录成功', login.status === 200 && login.body.user.role === 'superadmin', JSON.stringify(login.body));
  const me = await admin.get('/api/auth/me');
  ok('会话有效', me.status === 200 && me.body.user.username === 'admin');

  // ---------------------------------------------------------------- 用户
  console.log('\n[2] 用户管理');
  const uname = `tester${Date.now().toString().slice(-6)}`;
  const created = await admin.post('/api/users', {
    username: uname,
    displayName: '测试员',
    password: 'test1234',
    role: 'user',
  });
  ok('创建普通用户', created.status === 201 && created.body.user.username === uname, JSON.stringify(created.body));
  ok('重复用户名被拒绝', (await admin.post('/api/users', { username: uname, password: 'test1234' })).status === 409);
  ok('弱密码被拒绝', (await admin.post('/api/users', { username: `${uname}b`, password: '123' })).status === 400);

  const userList = await admin.get('/api/users');
  ok('用户列表包含新用户', userList.status === 200 && userList.body.users.some((u) => u.username === uname));

  const user = new Client();
  ok('新用户可以登录', (await user.post('/api/auth/login', { username: uname, password: 'test1234' })).status === 200);
  ok('普通用户访问用户管理被拒', (await user.get('/api/users')).status === 403);
  ok('普通用户改设置被拒', (await user.put('/api/settings', { asrBaseUrl: 'http://evil' })).status === 403);

  // ---------------------------------------------------------------- ASR
  console.log('\n[3] ASR 连通性');
  const health = await admin.get('/api/asr/health');
  ok('ASR 健康检查可连接', health.status === 200 && health.body.reachable === true, JSON.stringify(health.body));

  // ---------------------------------------------------------------- 任务
  console.log('\n[4] 创建任务（默认开启说话人分离）');
  const wantDiarize = process.env.HAS_HF_TOKEN === '1';
  // 说话人分离需要真人语音；正弦波只有音调，pyannote 检不出说话人。
  // 有 SPEECH_WAV 时用真实录音，否则退回合成音（此时不校验分离结果）。
  const speechPath = process.env.SPEECH_WAV;
  const hasSpeech = !!speechPath && fs.existsSync(speechPath);
  const audioBuf = hasSpeech ? fs.readFileSync(speechPath) : makeWav(1);
  const audioName = hasSpeech ? path.basename(speechPath) : '会议录音.wav';

  const form = new FormData();
  form.append('audio', new Blob([audioBuf], { type: 'audio/wav' }), audioName);
  form.append('title', '周会测试');
  form.append('diarize', wantDiarize ? '1' : '0');
  // 正弦波不是人声，自动识别会被误判成随机语言并触发大模型下载。
  // 显式指定语言，跳过语言检测。
  form.append('language', 'en');
  const createdTask = await user.req('/api/tasks', { method: 'POST', body: form });
  ok('上传创建任务成功', createdTask.status === 201, JSON.stringify(createdTask.body));
  const taskId = createdTask.body?.task?.id;
  ok('任务默认带说话人分离', createdTask.body?.task?.diarize === wantDiarize);
  ok('任务初始为排队/处理中', ['queued', 'processing'].includes(createdTask.body?.task?.status));

  let detail = null;
  for (let i = 0; i < 120; i += 1) {
    await sleep(1000);
    const res = await user.get(`/api/tasks/${taskId}`);
    detail = res.body?.task;
    if (detail && (detail.status === 'completed' || detail.status === 'failed')) break;
  }
  ok('任务完成', detail?.status === 'completed', detail?.errorMessage || detail?.status);
  ok(
    '文件名中文未乱码',
    detail?.originalName === audioName,
    `${detail?.originalName} (期望 ${audioName})`,
  );

  // 说话人分离需要 HF_TOKEN + 真人语音；缺任一项就只验证接口链路。
  const diarizeAvailable = process.env.HAS_HF_TOKEN === '1';
  const canCheckSpeakers = diarizeAvailable && hasSpeech;
  if (canCheckSpeakers) {
    ok('识别出多个说话人', (detail?.speakerCount ?? 0) >= 2, `speakerCount=${detail?.speakerCount}`);
    ok('分段带 speaker 字段', detail?.segments?.some((s) => !!s.speaker));
    ok('对话视图已合并', Array.isArray(detail?.speakerLines) && detail.speakerLines.length > 0);
  } else if (diarizeAvailable) {
    console.log('  - 跳过说话人数量断言（未提供 SPEECH_WAV 真人语音）');
    ok('分段带 speaker 字段', detail?.segments?.length === 0 || Array.isArray(detail?.segments));
  } else {
    console.log('  - 跳过说话人断言（未设置 HAS_HF_TOKEN=1）');
  }

  // ---------------------------------------------------------------- 隔离
  console.log('\n[5] 权限隔离');
  const other = new Client();
  const otherName = `${uname}x`;
  await admin.post('/api/users', { username: otherName, password: 'test1234', role: 'user' });
  await other.post('/api/auth/login', { username: otherName, password: 'test1234' });
  ok('他人访问该任务返回 404', (await other.get(`/api/tasks/${taskId}`)).status === 404);
  ok('他人访问音频返回 404', (await other.get(`/api/tasks/${taskId}/audio`)).status === 404);
  ok('他人不能删除该任务', (await other.del(`/api/tasks/${taskId}`)).status === 404);
  const otherList = await other.get('/api/tasks');
  ok('他人任务列表为空', otherList.body.total === 0, `total=${otherList.body.total}`);
  const adminList = await admin.get('/api/tasks');
  ok('管理员能看到所有人的任务', adminList.body.total >= 1);

  // ---------------------------------------------------------------- 导出
  console.log('\n[6] 导出与播放');
  for (const fmt of ['txt', 'srt', 'vtt', 'json']) {
    const res = await user.req(`/api/tasks/${taskId}/export?format=${fmt}`);
    ok(`导出 ${fmt.toUpperCase()}`, res.status === 200 && String(res.text).length > 0);
  }
  const srt = await user.req(`/api/tasks/${taskId}/export?format=srt`);
  ok('SRT 含时间轴', /-->/.test(String(srt.text)));
  if (canCheckSpeakers) {
    ok('SRT 含说话人标记', /\[SPEAKER_/.test(String(srt.text)));
  } else {
    // 未开说话人分离时，导出不应出现空说话人标记
    ok('未分离时无说话人标记', !/\[SPEAKER_/.test(String(srt.text)));
  }
  const audio = await user.req(`/api/tasks/${taskId}/audio`);
  ok('音频可回放', audio.status === 200);

  // ---------------------------------------------------------------- 存储
  console.log('\n[7] 存储管理');
  const storage = await user.get('/api/storage');
  ok('存储列表有文件', storage.status === 200 && storage.body.items.length >= 1);
  ok('存储统计有占用', storage.body.summary.totalBytes > 0);
  ok('孤立文件为 0', storage.body.summary.orphanCount === 0, `orphan=${storage.body.summary.orphanCount}`);

  const fileDelete = await user.del(`/api/storage/tasks/${taskId}`);
  ok('删除录音文件', fileDelete.status === 200 && fileDelete.body.removed === true);
  const afterDelete = await user.get(`/api/tasks/${taskId}`);
  ok('删除后任务仍保留文本', typeof afterDelete.body.task.text === 'string' && afterDelete.body.task.text.length > 0);
  ok('删除后 hasFile 为 false', afterDelete.body.task.hasFile === false);
  ok('删除后音频 404', (await user.get(`/api/tasks/${taskId}/audio`)).status === 404);
  ok('文件已删无法重试', (await user.post(`/api/tasks/${taskId}/retry`)).status === 400);

  // ---------------------------------------------------------------- 改密
  console.log('\n[8] 修改密码');
  ok('旧密码错误被拒', (await user.post('/api/auth/password', { currentPassword: 'nope', newPassword: 'abcdef' })).status === 400);
  ok('修改密码成功', (await user.post('/api/auth/password', { currentPassword: 'test1234', newPassword: 'newpass123' })).status === 200);
  const relogin = new Client();
  ok('新密码可登录', (await relogin.post('/api/auth/login', { username: uname, password: 'newpass123' })).status === 200);

  // ---------------------------------------------------------------- 收尾
  console.log('\n[9] 清理');
  ok('删除任务', (await admin.del(`/api/tasks/${taskId}`)).status === 200);
  ok('删除测试用户 1', (await admin.del(`/api/users/${created.body.user.id}`)).status === 200);

  console.log(`\n== ${failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`} ==\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
