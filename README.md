# 影舞 kagemai

インカメラで遊ぶブラウザMRリズムゲーム。カメラに映る自分の「影」と一緒に、
飛んでくるノーツを両手の「光の筆」で払って舞う。墨・和紙・金をモチーフにした
大人向けの和モダンな世界観。

- ビルドツール不使用。`index.html` + CDN(Three.js / Tone.js / MediaPipe)のみ
- スマホ(iOS Safari)と PC(Chrome)対応
- mp3 等の手持ち音源を読み込み、ビート解析して譜面を自動生成
- 内蔵デモ曲(Tone.js で生成する和風エレクトロニカ)で音源なしでも即プレイ可

## 遊び方

1. **はじめる** をタップ(音が鳴ります)
2. 入力モードを選ぶ
   - **カメラ**: インカメラに両手を映し、手でノーツに触れる/払う(推奨)
   - **タッチ**: 画面のノーツを直接なぞる・叩く
   - **マウス・キーボード**: マウスでなぞってクリック、または **D / F / J / K** キーでレーン判定
3. 曲を選ぶ
   - **内蔵デモ曲**、または **音楽ファイル**(mp3 / m4a / aac / wav / mp4・mov の音声)
   - ⚠️ Apple Music などの DRM 付きサブスク曲は読めません。「ファイル」App に保存した音源を選んでください
4. ノーツ密度(少なめ/普通/多め)と難易度を選ぶ
   - **通常 — 舞**: ノーツに触れるだけ
   - **高難度 — 乱舞**: 矢印ノーツは指定方向へ素早く払う(スワイプ)
5. 判定は **極(Perfect)/ 良(Good)/ 逸(Miss)** の3段階。判定窓は設定(左上「設」)で調整可能

その他:

- **解析プレビュー**: 検出ビート位置にクリック音を重ねて解析結果を耳で検証できる
- **デバッグ表示**: 設定画面のトグル、または **F2** キー(FPS・入力モード表示)

## 起動方法

### ローカル(PC)

```sh
node scripts/server.mjs            # http://127.0.0.1:4173/
# または
npx http-server -p 4173
```

`getUserMedia` の制約上、カメラモードは **HTTPS または localhost** でのみ動作します。

### スマホ実機で確認する(ローカルHTTPS)

LAN 経由の `http://192.168.x.x` ではカメラが使えないため、HTTPS で配信します。
[mkcert](https://github.com/FiloSottile/mkcert) を使う例:

```sh
mkcert -install                     # ローカルCAを信頼させる(初回のみ)
mkcert 192.168.x.x localhost        # 自分のPCのLAN IPで証明書を作成
node scripts/server.mjs --host 0.0.0.0 --port 4173 \
  --cert ./192.168.x.x+1.pem --key ./192.168.x.x+1-key.pem
# または: npx http-server -S -C ./192.168.x.x+1.pem -K ./192.168.x.x+1-key.pem
```

iPhone 側にも mkcert のルートCA(`mkcert -CAROOT` にある `rootCA.pem`)を
AirDrop 等で送り、設定 > 一般 > VPNとデバイス管理 でインストール後、
設定 > 一般 > 情報 > 証明書信頼設定 で信頼を有効にすると警告なしで開けます。

### GitHub Pages(いちばん簡単)

`main` ブランチへ push すると `.github/workflows/pages.yml` が自動デプロイします
(リポジトリの Settings > Pages で Source を **GitHub Actions** に設定)。
Pages は HTTPS なので iPhone からそのまま遊べます。

## テスト

```sh
npm ci                                   # 開発依存(Playwright)の導入
npm test                                 # ユニットテスト(解析・譜面・判定の純粋関数)
npx playwright install --with-deps chromium   # 初回のみ
npm run e2e                              # E2E スモークテスト(ダミーカメラ)
npm run test:all                         # 上記すべて
```

CI(GitHub Actions)では push ごとにユニットテストと E2E が実行されます。

## 構成

```
index.html            画面構造(タイトル/モード/曲選択/難易度/ガイド/HUD/リザルト)
css/style.css         和モダンUI(墨・和紙・金)
js/core/              純粋関数のみ(ブラウザAPI非依存・Nodeでテスト可能)
  analysis.js         ローパス→オンセット検出→BPM推定→ビートグリッド適合→量子化
  chart.js            譜面生成(密度・難易度・決定的乱数)
  judge.js            判定窓・2D重なり・スワイプ・スコア/ランク
js/input.js           入力抽象化(ポインタ2つの位置+速度に統一)
js/input-camera.js    カメラ入力(MediaPipe Hand Landmarker・遅延読み込み)
js/audio.js           AudioContext 管理・デコード・再生・クリック音
js/analysis-worker.js ビート解析ワーカー
js/demo-song.js       内蔵デモ曲(Tone.js オフラインレンダリング)
js/render.js          Three.js 描画(ノーツ・光の筆・背景・エフェクト)
js/game.js            ゲームループ・判定統合(AudioContext.currentTime 基準)
js/ui.js / js/main.js 画面遷移・フロー制御・設定
```

設計の詳細は [CLAUDE.md](CLAUDE.md) を参照。
