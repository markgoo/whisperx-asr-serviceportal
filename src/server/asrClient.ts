/**
 * Minimal Node 18-compatible client for the WhisperX ASR service.
 *
 * The portal sends `multipart/form-data` to `POST /asr`, which is the endpoint
 * of the upstream service that supports speaker diarization plus the model /
 * language / speaker-count knobs. `node:fetch` alone cannot stream a file from
 * disk without loading it into memory, so this uses `node:http`/`node:https`.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { URL } from 'node:url';

export interface AsrRequest {
  baseUrl: string;
  filePath: string;
  fileName: string;
  timeoutSec: number;
  options: {
    task: string;
    language?: string | null;
    model?: string | null;
    initialPrompt?: string | null;
    hotwords?: string | null;
    wordTimestamps: boolean;
    diarize: boolean;
    numSpeakers?: number | null;
    minSpeakers?: number | null;
    maxSpeakers?: number | null;
  };
  /** Aborts the HTTP request; the portal uses it for cancel. */
  signal?: AbortSignal;
}

export interface AsrSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

export interface AsrWord {
  word: string;
  start: number;
  end: number;
}

export interface AsrResult {
  text: string;
  language: string;
  segments: AsrSegment[];
  /** 词级时间戳（开启 word_timestamps 时才有），用于按停顿切分长句 */
  words: AsrWord[];
  raw: unknown;
}

export class AsrError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

function buildAsrUrl(baseUrl: string, options: AsrRequest['options']): URL {
  const url = new URL('/asr', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const q = url.searchParams;
  q.set('task', options.task || 'transcribe');
  q.set('output_format', 'json');
  q.set('word_timestamps', options.wordTimestamps ? 'true' : 'false');
  q.set('diarize', options.diarize ? 'true' : 'false');
  if (options.language) q.set('language', options.language);
  if (options.model) q.set('model', options.model);
  if (options.initialPrompt) q.set('initial_prompt', options.initialPrompt);
  if (options.hotwords) q.set('hotwords', options.hotwords);
  if (options.numSpeakers != null) q.set('num_speakers', String(options.numSpeakers));
  if (options.minSpeakers != null) q.set('min_speakers', String(options.minSpeakers));
  if (options.maxSpeakers != null) q.set('max_speakers', String(options.maxSpeakers));
  return url;
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
}

/** POST the audio file to /asr and resolve with the parsed JSON result. */
export function transcribeAudio(req: AsrRequest): Promise<AsrResult> {
  return new Promise<AsrResult>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const url = buildAsrUrl(req.baseUrl, req.options);
    const boundary = `----portal${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const fileName = path.basename(req.fileName) || 'audio.wav';
    const stat = fs.statSync(req.filePath);

    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio_file"; filename="${escapeQuoted(fileName)}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const headBuf = Buffer.from(head, 'utf8');
    const tailBuf = Buffer.from(tail, 'utf8');

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const requestOptions: http.RequestOptions = {
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': headBuf.length + stat.size + tailBuf.length,
        Accept: 'application/json',
      },
    };

    const httpReq = transport.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        const body = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          let detail = body.slice(0, 800);
          try {
            const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: string } };
            const d = parsed.detail ?? parsed.error?.message;
            if (typeof d === 'string') detail = d;
            else if (d !== undefined) detail = JSON.stringify(d);
          } catch {
            /* keep raw text */
          }
          return fail(new AsrError(`ASR 服务返回 ${status}：${detail}`, status));
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return fail(new AsrError('ASR 服务返回了无法解析的响应'));
        }
        settled = true;
        resolve(normalizeAsrResponse(parsed));
      });
    });

    httpReq.setTimeout(Math.max(30, req.timeoutSec) * 1000, () => {
      httpReq.destroy();
      fail(new AsrError(`ASR 请求超时（${req.timeoutSec} 秒）`));
    });
    httpReq.on('error', (err) => {
      fail(new AsrError(`无法连接 ASR 服务 ${req.baseUrl}：${err.message}`));
    });

    if (req.signal) {
      if (req.signal.aborted) {
        httpReq.destroy();
        return fail(new AsrError('任务已取消'));
      }
      req.signal.addEventListener(
        'abort',
        () => {
          httpReq.destroy();
          fail(new AsrError('任务已取消'));
        },
        { once: true },
      );
    }

    const stream = fs.createReadStream(req.filePath);
    stream.on('error', (err) => {
      httpReq.destroy();
      fail(new AsrError(`读取上传文件失败：${err.message}`));
    });
    httpReq.write(headBuf);
    stream.pipe(httpReq, { end: false });
    stream.on('end', () => {
      httpReq.end(tailBuf);
    });
  });
}

interface LooseAsrPayload {
  text?: unknown;
  segments?: unknown;
  language?: unknown;
  word_segments?: unknown;
}

export function normalizeAsrResponse(payload: unknown): AsrResult {
  const obj = (payload ?? {}) as LooseAsrPayload;
  const segmentsRaw = Array.isArray(obj.segments)
    ? obj.segments
    : // /asr with output_format=json puts the segment list in `text`
      Array.isArray(obj.text)
      ? (obj.text as unknown[])
      : [];
  const segments: AsrSegment[] = segmentsRaw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: typeof s.text === 'string' ? s.text.trim() : String(s.text ?? ''),
      speaker: typeof s.speaker === 'string' && s.speaker ? s.speaker : null,
    }))
    .filter((s) => s.text.length > 0);

  const joined = segments.map((s) => s.text).join(' ').trim();
  const text = typeof obj.text === 'string' ? obj.text.trim() || joined : joined;
  const language = typeof obj.language === 'string' ? obj.language : '';

  // 词级时间戳：优先用顶层的 word_segments，没有就把各段落里的 words 拍平
  const wordsRaw: unknown[] = Array.isArray(obj.word_segments)
    ? obj.word_segments
    : segmentsRaw.flatMap((seg) => {
        const w = (seg as Record<string, unknown>)?.words;
        return Array.isArray(w) ? w : [];
      });
  const words: AsrWord[] = wordsRaw
    .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
    .map((w) => ({
      word: typeof w.word === 'string' ? w.word : String(w.word ?? ''),
      start: Number(w.start) || 0,
      end: Number(w.end) || 0,
    }))
    .filter((w) => w.word.length > 0 && Number.isFinite(w.start));

  return { text, language, segments, words, raw: payload };
}

/** Cheap reachability probe for the settings / dashboard page. */
export function checkAsrHealth(baseUrl: string, timeoutMs = 4000): Promise<{
  reachable: boolean;
  latencyMs: number | null;
  device?: string;
  version?: string;
  serveMode?: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    let url: URL;
    try {
      url = new URL('/health', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    } catch {
      return resolve({ reachable: false, latencyMs: null, error: '地址格式不正确' });
    }
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    let done = false;
    const finish = (value: {
      reachable: boolean;
      latencyMs: number | null;
      device?: string;
      version?: string;
      serveMode?: string;
      error?: string;
    }): void => {
      if (done) return;
      done = true;
      resolve(value);
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
              device: typeof body.device === 'string' ? body.device : undefined,
              version: typeof body.version === 'string' ? body.version : undefined,
              serveMode: typeof body.serve_mode === 'string' ? body.serve_mode : undefined,
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
    req.on('error', (err) => {
      finish({ reachable: false, latencyMs: null, error: err.message });
    });
    req.end();
  });
}
