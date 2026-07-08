// kagemai — 舞モード(なぞり)E2E テスト
// マウスをドラッグして筆致をなぞり、リザルトまで到達することを確認する。

import { test, expect } from '@playwright/test';
import { routeCdn } from './support/cdn.mjs';

test.beforeEach(async ({ page }) => {
  await routeCdn(page);
});

test('舞モード: デモ曲をなぞってリザルトまで到達する', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto('/?song=short');
  await page.getByTestId('start').click();
  await page.getByTestId('mode-mouse').click();
  await page.getByTestId('demo-song').click();
  await expect(page.locator('#song-info')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('to-difficulty').click();

  await page.getByTestId('playmode-mai').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  await expect(page.locator('#mai-gauge')).toBeVisible();

  // マウスを押したまま画面全体を大きくなぞり続ける
  const box = page.viewportSize();
  await page.mouse.move(box.width * 0.5, box.height * 0.5);
  await page.mouse.down();
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < 16_000) {
    const u = i * 0.35;
    const x = box.width * (0.5 + 0.38 * Math.cos(u));
    const y = box.height * (0.47 + 0.28 * Math.sin(u * 1.3));
    await page.mouse.move(x, y, { steps: 4 });
    await page.waitForTimeout(50);
    i++;
    if (await page.locator('#screen-result').isVisible()) break;
  }
  await page.mouse.up();

  await expect(page.locator('#screen-result')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('result-score')).toHaveText(/^\d+$/);
  // 舞モードのリザルトには拍合が表示される
  await expect(page.locator('#result-beat-row')).toBeVisible();
  // なぞり続けたので何かしらの評価は得られている(極+良 >= 1)
  const perfect = Number(await page.locator('#result-perfect').textContent());
  const good = Number(await page.locator('#result-good').textContent());
  expect(perfect + good).toBeGreaterThan(0);

  const inGameErrors = await page.evaluate(() => window.__kagemai.errors);
  expect(inGameErrors).toEqual([]);
  expect(errors).toEqual([]);
});
