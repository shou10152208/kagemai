import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// このサンドボックス/CI どちらでも動くよう、プロキシ環境変数があれば
// Chromium にそのまま渡す(localhost はプロキシを経由しない)。
const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || null;

// バージョン固定済みの Chromium が用意された環境(リモートサンドボックス等)では
// それを使う。CI では `npx playwright install chromium` した標準のものを使う。
const pinnedChromium = '/opt/pw-browsers/chromium';
const executablePath = !process.env.CI && existsSync(pinnedChromium) ? pinnedChromium : undefined;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.mjs',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list']],
  webServer: {
    command: 'node scripts/server.mjs --port 4173',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    ignoreHTTPSErrors: !!proxyServer,
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: [
        // カメラ許可ダイアログを出さず、ダミーカメラ映像を使う
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        ...(proxyServer ? ['--ignore-certificate-errors'] : []),
      ],
      ...(proxyServer ? { proxy: { server: proxyServer, bypass: '127.0.0.1,localhost' } } : {}),
    },
  },
});
