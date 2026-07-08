// kagemai — E2E スモークテスト
// 「起動 → デモ曲 → プレイ開始 → スコア表示」までエラーなく到達することを確認する。

import { test, expect } from '@playwright/test';
import { routeCdn } from './support/cdn.mjs';

// CDN アセットはローカルキャッシュから返す(テストの決定性のため)
test.beforeEach(async ({ page }) => {
  await routeCdn(page);
});

// ヘッドレス環境の GPU ドライバが出す性能警告(アプリ起因ではない)は除外する
const BENIGN = [/GL Driver Message/, /GPU stall due to ReadPixels/, /SwiftShader/];

/** console error / pageerror を収集する */
function watchErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const text = msg.text();
      if (BENIGN.some((re) => re.test(text))) return;
      errors.push(`console.${msg.type()}: ${text}`);
    }
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test('起動 → デモ曲(短縮版) → マウスモードでプレイ → リザルト表示', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/?song=short');
  await expect(page.locator('.game-title')).toHaveText('影舞');

  await page.getByTestId('start').click();
  await expect(page.locator('#screen-mode')).toBeVisible();

  await page.getByTestId('mode-mouse').click();
  await expect(page.locator('#screen-song')).toBeVisible();

  // デモ曲生成(Tone.js オフラインレンダリング)
  await page.getByTestId('demo-song').click();
  await expect(page.locator('#song-info')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#song-meta')).toContainText('BPM');

  await page.getByTestId('to-difficulty').click();
  await page.getByTestId('difficulty-normal').click();

  // カウントダウン → プレイ画面
  await expect(page.locator('#screen-play')).toBeVisible();

  // プレイ中: ノーツを狙わず画面中央でクリック連打(スコアは0でもよい)
  await page.waitForTimeout(4000);
  const box = page.viewportSize();
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(box.width * (0.3 + 0.1 * i), box.height * 0.45, { steps: 5 });
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
  }
  // キーボードレーン入力も叩いておく
  for (const key of ['KeyD', 'KeyF', 'KeyJ', 'KeyK']) {
    await page.keyboard.press(key === 'KeyD' ? 'd' : key === 'KeyF' ? 'f' : key === 'KeyJ' ? 'j' : 'k');
    await page.waitForTimeout(200);
  }

  // 短縮デモ(約15秒)の終了後にリザルトへ遷移する
  await expect(page.locator('#screen-result')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('result-score')).toHaveText(/^\d+$/);

  // ゲーム内部のエラー記録も空であること
  const inGameErrors = await page.evaluate(() => window.__kagemai.errors);
  expect(inGameErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test('設定: ヒット音の切替(試聴)と判定窓・デバッグ表示の操作', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await page.getByTestId('start').click();
  await page.getByTestId('mode-mouse').click();

  await page.locator('#btn-settings').click();
  await expect(page.locator('#settings-modal')).toBeVisible();

  // ヒット音を順に切替(クリックごとに試聴が鳴る)
  for (const kind of ['suzu', 'hyoshigi', 'tsuzumi', 'none']) {
    await page.locator(`#settings-hitsound-seg [data-hitsound="${kind}"]`).click();
    await expect(page.locator(`#settings-hitsound-seg [data-hitsound="${kind}"]`)).toHaveClass(/is-active/);
  }
  // 設定が保存されている
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('kagemai-settings')).hitSound);
  expect(saved).toBe('none');

  await page.locator('#window-slider').fill('200');
  await expect(page.locator('#window-value')).toHaveText('±200ms');
  await page.locator('#debug-toggle').check();
  await expect(page.locator('#debug-overlay')).toBeVisible();

  await page.locator('#btn-settings-close').click();
  await expect(page.locator('#settings-modal')).toBeHidden();
  expect(errors).toEqual([]);
});

test('リトライで再プレイできる(中断→曲選択にも戻れる)', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/?song=short');
  await page.getByTestId('start').click();
  await page.getByTestId('mode-mouse').click();
  await page.getByTestId('demo-song').click();
  await expect(page.locator('#song-info')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('to-difficulty').click();
  await page.getByTestId('difficulty-hard').click();
  await expect(page.locator('#screen-play')).toBeVisible();

  // 中断して曲選択へ戻る
  await page.waitForTimeout(2500);
  await page.locator('#btn-quit').click();
  await expect(page.locator('#screen-song')).toBeVisible();

  // もう一度プレイしてリザルトまで
  await page.getByTestId('to-difficulty').click();
  await page.getByTestId('difficulty-normal').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  await expect(page.locator('#screen-result')).toBeVisible({ timeout: 40_000 });

  await page.getByTestId('retry').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  await page.locator('#btn-quit').click();
  await expect(page.locator('#screen-song')).toBeVisible();

  expect(errors).toEqual([]);
});
