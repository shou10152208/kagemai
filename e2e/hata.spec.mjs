// kagemai — 旗印モード(旗上げ式)E2E テスト
// マウスを素早く回して全方向へ振り続け、出題に反応できることを確認する。

import { test, expect } from '@playwright/test';
import { routeCdn } from './support/cdn.mjs';

test.beforeEach(async ({ page }) => {
  await routeCdn(page);
});

test('旗印モード: デモ曲で矢印に反応してリザルトまで到達する', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto('/?song=short');
  await page.getByTestId('start').click();
  await page.getByTestId('mode-mouse').click();
  await page.getByTestId('demo-song').click();
  await expect(page.locator('#song-info')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('to-difficulty').click();

  await page.getByTestId('playmode-hata').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  await expect(page.locator('#mai-gauge')).toBeVisible();

  // ページ内で合成 PointerEvent を高頻度発火し、速い円運動(全方向)を作る。
  // (Playwright のマウス移動はプロトコル往復が遅く、実際の手の速度を再現できないため)
  await page.evaluate(() => {
    const dispatch = (type, x, y) => window.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, pointerType: 'mouse', buttons: 1, pointerId: 1, bubbles: true,
    }));
    dispatch('pointerdown', innerWidth / 2, innerHeight / 2);
    let u = 0;
    window.__hataDriver = setInterval(() => {
      u += 0.7; // 約0.2秒で1周 → 常に全方向へ速く振っている状態
      dispatch('pointermove',
        innerWidth * (0.5 + 0.3 * Math.cos(u)),
        innerHeight * (0.45 + 0.25 * Math.sin(u)));
    }, 25);
  });

  await expect(page.locator('#screen-result')).toBeVisible({ timeout: 40_000 });
  await page.evaluate(() => clearInterval(window.__hataDriver));
  await expect(page.getByTestId('result-score')).toHaveText(/^\d+$/);
  // 振り続けたので何かしらの評価は得られている
  const perfect = Number(await page.locator('#result-perfect').textContent());
  const good = Number(await page.locator('#result-good').textContent());
  expect(perfect + good).toBeGreaterThan(0);

  const inGameErrors = await page.evaluate(() => window.__kagemai.errors);
  expect(inGameErrors).toEqual([]);
  expect(errors).toEqual([]);
});
