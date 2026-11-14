/**
 * 标点恢复服务客户端。
 *
 * 服务见 docker/punc-service：FunASR 的 CT-Transformer，
 * 输入无标点中文、输出带「，。？」的文本。
 *
 * 调用方负责分段（时间轴由 ASR 决定），这里只把每段的文字标点补对。
 * 服务不可用时应退回内置的启发式标点，不能让它阻塞转写。
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface VadResult {
  /** 语音段 [[start, end], ...] 秒 */
  speech: Array<[number, number]>;
  /** 相邻语音段之间的静音 [[start, end], ...] 秒 */
  gaps: Array<[number, number]>;
  elapsedMs: number;
}

export interface PuncResult {
  texts: string[];
  elapsedMs: number;
}

/** 单次请求的段数上限，避免一次塞太多把服务压住。 */
const MAX_BATCH = 100;

function postJsonTo(
  baseUrl: string,
  pathName: string,
  payload: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(pathName, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const isHttps = u.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            return reject(new Error(`标点服务返回 ${status}: ${text.slice(0, 300)}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('标点服务返回了无法解析的响应'));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`标点服务超时（${Math.round(timeoutMs / 1000)}s）`));
    });
    req.on('error', (err) => reject(new Error(`无法连接标点服务：${err.message}`)));
    req.write(body);
    req.end();
  });
}

/**
 * 批量给文本加标点。
 *
 * 会先去掉文本里已有的标点——传进来的可能是启发式补过的，
 * 让模型从干净文本重新判断，避免错误标点被当成提示。
 */
export async function punctuateTexts(
  baseUrl: string,
  texts: string[],
  timeoutMs = 60_000,
): Promise<PuncResult> {
  if (!texts.length) return { texts: [], elapsedMs: 0 };

  const cleaned = texts.map((t) => t.replace(/[，。！？；、,.;?!]/g, '').trim());
  const out: string[] = [];
  let elapsed = 0;

  for (let i = 0; i < cleaned.length; i += MAX_BATCH) {
    const batch = cleaned.slice(i, i + MAX_BATCH);
    const started = Date.now();
    const res = (await postJsonTo(baseUrl, '/punc', { texts: batch }, timeoutMs)) as PuncResult;
    elapsed += Date.now() - started;
    if (!Array.isArray(res.texts) || res.texts.length !== batch.length) {
      throw new Error('标点服务返回的段数与请求不一致');
    }
    out.push(...res.texts);
  }

  return { texts: out, elapsedMs: elapsed };
}

/**
 * 调 VAD 接口，拿语音段之间的静音区间。
 *
 * 传的是服务端路径而不是文件内容——punc 容器只读挂载了门户的 data 卷，
 * 这样上百 MB 的录音不用再传一遍。
 */
export async function detectSilence(
  baseUrl: string,
  audioPath: string,
  timeoutMs = 120_000,
): Promise<VadResult> {
  const res = (await postJsonTo(baseUrl, '/vad', { path: audioPath }, timeoutMs)) as VadResult;
  if (!Array.isArray(res.speech) || !Array.isArray(res.gaps)) {
    throw new Error('VAD 服务返回结构不正确');
  }
  return res;
}

/** 健康检查，供设置页「测试连接」用。 */
export function checkPuncHealth(baseUrl: string, timeoutMs = 4000): Promise<{
  reachable: boolean;
  latencyMs: number | null;
  model?: string;
  device?: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL('/health', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    } catch {
      return resolve({ reachable: false, latencyMs: null, error: '地址格式不正确' });
    }
    const started = Date.now();
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    let done = false;
    const finish = (v: {
      reachable: boolean;
      latencyMs: number | null;
      model?: string;
      device?: string;
      error?: string;
    }): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const req = transport.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const latencyMs = Date.now() - started;
          if ((res.statusCode ?? 0) >= 400) {
            return finish({ reachable: false, latencyMs, error: `HTTP ${res.statusCode}` });
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            finish({
              reachable: true,
              latencyMs,
              model: typeof body.model === 'string' ? body.model : undefined,
              device: typeof body.device === 'string' ? body.device : undefined,
            });
          } catch {
            finish({ reachable: true, latencyMs });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish({ reachable: false, latencyMs: null, error: '连接超时' });
    });
    req.on('error', (err) => finish({ reachable: false, latencyMs: null, error: err.message }));
    req.end();
  });
}
