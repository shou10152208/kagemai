# kagemai 開発メモ(アーキテクチャと設計原則)

ブラウザだけで動くMRリズムゲーム。ビルドツール不使用、CDN(Three.js / Tone.js /
MediaPipe Tasks Vision)+ ES Modules のみ。iOS Safari と PC Chrome が対象。

## 設計原則(変更時も必ず守ること)

### 1. 入力抽象化レイヤー

ゲーム本体(`js/game.js`)は入力デバイスを知らない。`js/input.js` の
`InputManager` が全モードを「**ポインタ配列**」に統一する:

```
pointer = { id, hand:'L'|'R', x, y, vx, vy, active }
```

- `x, y`: 画面正規化座標(0..1)。`vx, vy`: 高さ基準の正規化速度(x はアスペクト補正済み)
- カメラ(`js/input-camera.js`、動的 import)/ タッチ / マウスがこの形式を生成
- キーボード(D/F/J/K)のみ例外で `onLaneKey(lane)` コールバック(レーン+時刻判定)
- カメラは cover 表示のクロップと鏡像を考慮して座標変換する(`input-camera.js` 参照)

### 2. ロジックとブラウザAPIの分離

`js/core/` は **純粋関数のみ**。Float32Array と数値だけを受け取り、DOM /
AudioContext / Three.js に依存しない。Node のユニットテスト(`test/`)から直接
import される。ビート解析・BPM推定・譜面生成・判定計算をいじる時は必ずここで行い、
対応するテストを更新すること。

- `core/analysis.js`: mixdown → decimate → lowpass(150Hz)→ エネルギー包絡線 →
  オンセット検出 → 間隔KDEでBPM推定 → 最小二乗でグリッド適合 → 量子化
- `core/chart.js`: 量子化オンセット+密度/難易度からノーツ配列(決定的乱数 mulberry32)
- `core/judge.js`: 判定窓(境界含む)・2D重なり(Z座標不使用)・スワイプ・スコア/ランク

ブラウザ側の解析実行は `js/analysis-worker.js`(Web Worker)経由。

### 3. 同期(最重要)

- ノーツの出現・判定・描画は **すべて `AudioContext.currentTime` 基準**。
  `songTime = ctx.currentTime - songStartAt` を毎フレーム計算して位置を逆算する
- `setTimeout` / `setInterval` / フレーム数によるタイミング管理は禁止
  (処理落ちしてもズレない構造を維持する)
- カウントダウンも `songStartAt`(未来時刻)からの逆算で表示する
- AudioContext の生成 / resume は必ずユーザー操作イベント内(`AudioEngine.ensure()`)

### 4. その他の約束事

- 判定にポインタの Z 座標は使わない(判定プレーン到達時刻 ±窓 × 2D重なりのみ)
- カメラ失敗は握りつぶさず、理由を表示してタッチ/マウスへの切替を案内する
- CSS: `[hidden] { display:none !important }` を前提に hidden 属性で表示制御している
  (`display` を持つクラスを足しても壊れない)
- E2E は CDN アセットを `e2e/support/cdn.mjs` でローカルキャッシュから返す
  (決定性のため。新しい CDN 依存を足したら `CDN_ASSETS` に追記する)
- ユーザー向けの変更をしたら `js/version.js` の `VERSION` を上げる
  (画面右下に常時表示され、スクリーンショットからバージョンを特定できる)
- 背景テーマは CSS(`body[data-theme]` の変数)と WebGL(`render.js` の `THEMES`)の
  両方に定義がある。テーマを足す時は両方+設定UIに追記する

## コマンド

```sh
npm test          # ユニットテスト(node:test、core/ の純粋関数)
npm run e2e       # Playwright E2E(ダミーカメラ: --use-fake-device-for-media-stream)
npm run test:all  # 両方
npm start         # ローカル配信 http://127.0.0.1:4173/(scripts/server.mjs)
```

- 初回のみ `npm ci && npx playwright install --with-deps chromium`
- E2E 用の短縮デモ曲は `/?song=short`(約15秒)
- E2E フック: `window.__kagemai = { screen, errors, trace, lastResult }`

## 配信

- CI: `.github/workflows/ci.yml`(push ごとにユニット+E2E)
- 公開: `.github/workflows/pages.yml`(main への push で GitHub Pages へ。
  Settings > Pages の Source を GitHub Actions にしておく)
- ローカル HTTPS(スマホ実機のカメラ確認用)は README の mkcert 手順を参照
