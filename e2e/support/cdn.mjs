// E2E 用 CDN アセットキャッシュ
// テストを決定的にするため、CDN のアセットを事前ダウンロードして
// Playwright の route インターセプトでローカルから返す。
// (本番コードは CDN を直接読む。ここはテスト環境の再現性のための仕組み)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.cdn-cache');

export const CDN_ASSETS = [
  {
    url: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
    file: 'three.module.js',
    type: 'text/javascript',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/tone@14.8.49/build/Tone.js',
    file: 'Tone.js',
    type: 'text/javascript',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    file: 'vision_bundle.mjs',
    type: 'text/javascript',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js',
    file: 'vision_wasm_internal.js',
    type: 'text/javascript',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm',
    file: 'vision_wasm_internal.wasm',
    type: 'application/wasm',
  },
  {
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    file: 'hand_landmarker.task',
    type: 'application/octet-stream',
  },
];

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/** 不足しているアセットを curl でダウンロードする(globalSetup から呼ぶ) */
export async function ensureCdnCache() {
  await mkdir(CACHE_DIR, { recursive: true });
  for (const asset of CDN_ASSETS) {
    const dest = join(CACHE_DIR, asset.file);
    if (await exists(dest)) continue;
    console.log(`[cdn-cache] downloading ${asset.url}`);
    await execFileP('curl', ['-sS', '-f', '-L', '--retry', '3', '-o', dest, asset.url]);
  }
}

/** ページの CDN リクエストをローカルキャッシュから返す */
export async function routeCdn(page) {
  const byUrl = new Map(CDN_ASSETS.map((a) => [a.url, a]));
  const handler = async (route) => {
    const asset = byUrl.get(route.request().url());
    if (!asset) return route.continue();
    const body = await readFile(join(CACHE_DIR, asset.file));
    return route.fulfill({ status: 200, contentType: asset.type, body });
  };
  await page.route('https://cdn.jsdelivr.net/**', handler);
  await page.route('https://storage.googleapis.com/**', handler);
}
