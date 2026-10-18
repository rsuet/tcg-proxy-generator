#!/usr/bin/env node
// TCG Proxy Generator のサーバー。
// public/ の静的ファイル配信と、外部URLの画像を取得してブラウザへ中継する /api/image を提供する。
// （ブラウザから直接取得した外部画像は CORS の制約で canvas から読み出せないため、同一オリジンで中継する）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
// ブラウザ以外からのアクセスを拒否する画像サーバーがあるため、一般的なブラウザのUAを名乗る
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

async function proxyImage(res, rawUrl) {
  let target;
  try {
    target = new URL(rawUrl ?? '');
  } catch {
    return sendError(res, 400, 'URLの形式が正しくありません');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return sendError(res, 400, 'http:// または https:// で始まるURLを指定してください');
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        // 直リンク対策で Referer を確認するサーバー向けに、画像と同じサイトを参照元にする
        Referer: `${target.origin}/`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'タイムアウトしました' : `接続できませんでした (${err.cause?.code ?? err.message})`;
    return sendError(res, 502, `画像の取得に失敗しました: ${reason}`);
  }

  const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  let rejection;
  if (!upstream.ok) {
    rejection = [502, `画像の取得に失敗しました: HTTP ${upstream.status}`];
  } else if (contentType === 'text/html') {
    rejection = [415, '画像ではなくWebページのURLです。画像を右クリックして「画像アドレスをコピー」したURLを指定してください'];
  } else if (contentType && !contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
    rejection = [415, `画像ではないデータが返されました (${contentType})`];
  } else if (Number(upstream.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    rejection = [413, '画像が大きすぎます（上限30MB）'];
  }
  if (rejection) {
    await upstream.body?.cancel();
    return sendError(res, ...rejection);
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of upstream.body ?? []) {
      size += chunk.byteLength;
      // ループを抜けるとストリームは自動でキャンセルされる
      if (size > MAX_IMAGE_BYTES) return sendError(res, 413, '画像が大きすぎます（上限30MB）');
      chunks.push(chunk);
    }
  } catch (err) {
    return sendError(res, 502, `画像の受信中にエラーが発生しました (${err.message})`);
  }

  res.writeHead(200, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-store',
  });
  res.end(Buffer.concat(chunks));
}

async function serveStatic(res, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return sendError(res, 400, 'Bad Request');
  }
  if (relative.endsWith('/')) relative += 'index.html';
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendError(res, 403, 'Forbidden');

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return sendError(res, 404, 'Not Found');
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/image') await proxyImage(res, searchParams.get('url'));
    else await serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    if (res.headersSent) res.end();
    else sendError(res, 500, 'サーバー内部でエラーが発生しました');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} は使用中です。PORT=3001 node server.js のように別のポートを指定してください。`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const host = HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`TCG Proxy Generator: http://${host}:${PORT}`);
});
