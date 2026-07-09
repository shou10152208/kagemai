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

  // 背景テーマの切替(CSS 変数と WebGL 背景の両方に反映される)
  for (const theme of ['yoi', 'sakura', 'washi', 'sumi']) {
    await page.locator(`#settings-theme-seg [data-theme="${theme}"]`).click();
    await expect(page.locator('body')).toHaveAttribute('data-theme', theme);
  }

  // ヒット音量スライダー
  await page.locator('#hitvol-slider').fill('30');
  await expect(page.locator('#hitvol-value')).toHaveText('30%');
  const savedVol = await page.evaluate(() => JSON.parse(localStorage.getItem('kagemai-settings')).hitVolume);
  expect(savedVol).toBe(30);

  await page.locator('#window-slider').fill('200');
  await expect(page.locator('#window-value')).toHaveText('±200ms');

  // カメラ遅延補正スライダー
  await page.locator('#camlat-slider').fill('150');
  await expect(page.locator('#camlat-value')).toHaveText('150ms');
  const savedLat = await page.evaluate(() => JSON.parse(localStorage.getItem('kagemai-settings')).cameraLatencyMs);
  expect(savedLat).toBe(150);

  // タイミング調整スライダー
  await page.locator('#offset-slider').fill('-100');
  await expect(page.locator('#offset-value')).toHaveText('-100ms');
  const savedOffset = await page.evaluate(() => JSON.parse(localStorage.getItem('kagemai-settings')).audioOffsetMs);
  expect(savedOffset).toBe(-100);
  await page.locator('#debug-toggle').check();
  await expect(page.locator('#debug-overlay')).toBeVisible();

  await page.locator('#btn-settings-close').click();
  await expect(page.locator('#settings-modal')).toBeHidden();
  expect(errors).toEqual([]);
});

test('タイミング校正: タップして測定値を保存できる', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await page.getByTestId('start').click();
  await page.getByTestId('mode-mouse').click();
  await page.locator('#btn-settings').click();
  await page.locator('#btn-calibrate').click();
  await expect(page.locator('#screen-calibration')).toBeVisible();

  // ビート(0.6s間隔、1.2s後開始)に合わせて 10回タップ(練習2+計測8)
  await page.waitForTimeout(1300);
  for (let i = 0; i < 10; i++) {
    await page.mouse.click(200, 400);
    await page.waitForTimeout(600);
  }
  await expect(page.locator('#calib-status')).toContainText('聞こえています', { timeout: 10_000 });
  await page.getByTestId('calib-done').click();
  await expect(page.locator('#screen-song')).toBeVisible();

  // 測定値(数値)が保存されている
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('kagemai-settings')).audioOffsetMs);
  expect(typeof saved).toBe('number');
  expect(errors).toEqual([]);
});

test('バージョン表記が常時表示されている', async ({ page }) => {
  await page.goto('/');
  const tag = page.locator('#version-tag');
  await expect(tag).toBeVisible();
  // ローカルは 'dev'、Pages ではデプロイ時にコミット短縮ハッシュへ書き換えられる
  await expect(tag).toHaveText(/^影舞 (dev|[0-9a-f]{7} \(\d{4}-\d{2}-\d{2}\))$/);
  // 画面遷移後も表示され続ける
  await page.getByTestId('start').click();
  await expect(tag).toBeVisible();
  const hookVersion = await page.evaluate(() => window.__kagemai.version);
  expect(`影舞 ${hookVersion}`).toBe(await tag.textContent());
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
