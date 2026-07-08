// kagemai — カメラモード(MediaPipe)E2E テスト
// Chromium のダミーカメラ(--use-fake-device-for-media-stream)で
// カメラ初期化〜ガイド画面〜プレイ開始が通ることを確認する。

import { test, expect } from '@playwright/test';
import { routeCdn } from './support/cdn.mjs';

test.beforeEach(async ({ page }) => {
  await routeCdn(page);
});

test('カメラモード: ダミーカメラでガイド画面まで到達し、失敗時は理由が表示される', async ({ page }) => {
  await page.goto('/?song=short');
  await page.getByTestId('start').click();
  await page.getByTestId('mode-camera').click();
  await page.getByTestId('demo-song').click();
  await expect(page.locator('#song-info')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('to-difficulty').click();
  await page.getByTestId('difficulty-normal').click();

  // ガイド画面(カメラ+モデル読み込み)か、失敗時はモード画面+理由表示のどちらかに到達する
  const modeScreen = page.locator('#screen-mode');
  await expect(page.locator('#screen-guide:not([hidden]), #screen-mode:not([hidden])'))
    .toBeVisible({ timeout: 90_000 });
  if (await modeScreen.isVisible()) {
    await expect(page.locator('#mode-note')).toContainText('カメラ');
  } else {
    // ガイドからプレイ開始できること(ダミーカメラでは手は検出されない)
    await expect(page.locator('#btn-guide-start')).toBeEnabled({ timeout: 90_000 });
    await page.locator('#btn-guide-start').click();
    await expect(page.locator('#screen-play')).toBeVisible();
    await page.locator('#btn-quit').click();
  }
});
