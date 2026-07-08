// kagemai — 音楽ファイル読み込み+ビート解析の E2E テスト
// 既知 BPM(120)のクリックトラック WAV を生成してアップロードし、
// デコード成否表示 → BPM 推定 → 解析プレビュー → プレイ開始までを検証する。

import { test, expect } from '@playwright/test';
import { routeCdn } from './support/cdn.mjs';
import { makeClickTrackWav } from './support/wav.mjs';

test.beforeEach(async ({ page }) => {
  await routeCdn(page);
});

test('WAV アップロード → 解析(BPM 120)→ プレビュー → プレイ開始', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start').click();
  await page.getByTestId('mode-mouse').click();

  // ファイル選択(input は accept に MIME と拡張子を併記している)
  const accept = await page.locator('#file-input').getAttribute('accept');
  expect(accept).toContain('audio/*');
  expect(accept).toContain('.mp3');
  expect(accept).not.toBe('audio/mp3'); // iOS で mp3 が選択不可になる誤設定の回帰防止

  await page.locator('#file-input').setInputFiles({
    name: 'click-120bpm.wav',
    mimeType: 'audio/wav',
    buffer: makeClickTrackWav({ bpm: 120, duration: 20 }),
  });

  // ファイル名・デコード成否・推定BPM・ノーツ数の表示
  await expect(page.locator('#song-info')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#song-name')).toHaveText('click-120bpm.wav');
  await expect(page.locator('#song-meta')).toContainText('デコード成功');
  await expect(page.locator('#song-meta')).toContainText('ノーツ数');
  const meta = await page.locator('#song-meta').textContent();
  const bpm = Number(meta.match(/推定BPM ([\d.]+)/)[1]);
  expect(Math.abs(bpm - 120)).toBeLessThan(2);

  // 解析プレビュー(ビート位置のクリック音再生画面)
  await page.locator('#btn-preview').click();
  await expect(page.locator('#screen-preview')).toBeVisible();
  await expect(page.locator('#preview-status')).toContainText('ビート数');
  await page.waitForTimeout(1500);
  await page.locator('#btn-preview-stop').click();
  await expect(page.locator('#screen-song')).toBeVisible();

  // そのままプレイ開始できる
  await page.getByTestId('to-difficulty').click();
  await page.getByTestId('difficulty-normal').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  await page.locator('#btn-quit').click();
  await expect(page.locator('#screen-song')).toBeVisible();

  const inGameErrors = await page.evaluate(() => window.__kagemai.errors);
  expect(inGameErrors).toEqual([]);
});

test('デコード不能なファイルは理由が表示される', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start').click();
  await page.getByTestId('mode-mouse').click();

  await page.locator('#file-input').setInputFiles({
    name: 'broken.mp3',
    mimeType: 'audio/mpeg',
    buffer: Buffer.from('これは音声ではないデータ'),
  });
  await expect(page.locator('#song-error')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#song-error')).toContainText('デコードできませんでした');
});
