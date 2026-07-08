// kagemai — アプリ全体のフロー制御
// タイトル → 入力モード確認 → 曲選択(mp3/デモ) → 解析 → 難易度選択
// → (カメラ時: 立ち位置ガイド) → カウントダウン → プレイ → リザルト

import { AudioEngine } from './audio.js';
import { InputManager, detectRecommendedMode, cameraUnavailableReason, MODE_LABELS } from './input.js';
import { Stage } from './render.js';
import { UI } from './ui.js';
import { Game } from './game.js';
import { renderDemoSong } from './demo-song.js';
import { generateChart, beatsFromBpm } from './core/chart.js';
import { generateStrokeChart } from './core/stroke.js';
import { VERSION } from './version.js';

const params = new URLSearchParams(location.search);

// ---- 設定(localStorage 永続化) ----
const DEFAULT_SETTINGS = {
  inputMode: null,
  judgeWindowMs: 150,
  density: 'normal',
  debug: false,
  judgeRadius: 0.09,
  minSwipeSpeed: 1.0,
  hitSound: 'suzu',
  hitVolume: 80,
  theme: 'sumi',
  cameraLatencyMs: 100,
  audioOffsetMs: 0,
};
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('kagemai-settings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try { localStorage.setItem('kagemai-settings', JSON.stringify(settings)); } catch { /* private mode 等 */ }
}
const settings = loadSettings();

// ---- E2E/デバッグ用フック ----
window.__kagemai = { screen: null, errors: [], settings, version: VERSION };
window.addEventListener('error', (e) => window.__kagemai.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__kagemai.errors.push(String(e.reason)));

// ---- 各要素 ----
const audio = new AudioEngine();
const input = new InputManager();
const ui = new UI();
const stage = new Stage(document.getElementById('stage'));
const videoEl = document.getElementById('camera-video');

const state = {
  song: null,        // {type, name, buffer, bpm, offset, duration, onsets, nudgeMs}
  playMode: 'mai',   // 'mai'(なぞり) | 'timing'(律/乱舞)
  difficulty: 'normal',
  recommended: 'mouse',
};

// 画面遷移時の共通処理(設定ボタンの表示制御)
const showScreen = (name) => {
  ui.show(name);
  document.getElementById('btn-settings').hidden =
    ['title', 'play', 'guide', 'preview'].includes(name);
};

// ---- ゲーム本体 ----
const game = new Game({
  audio, input, stage, settings,
  callbacks: {
    onJudge: (judge, note) => ui.popJudge(judge, note.x, note.y),
    onBeatHit: (pointer) => ui.popJudge('beat', pointer.x, pointer.y - 0.06),
    onHud: (hud) => {
      ui.setHud(hud);
      if (hud.gauge !== undefined) ui.setGauge(hud.gauge, hud.fever);
    },
    onCountdown: (n) => ui.countdown(n),
    onFinish: (results) => showResult(results),
    onQuit: () => {},
    onDebug: (text) => ui.debug(text),
  },
});

// ---- タイトル ----
ui.bind('btn-start', () => {
  audio.ensure(); // ユーザー操作イベント内で AudioContext を生成
  showScreen('mode');
});

detectRecommendedMode().then((m) => {
  state.recommended = m;
  if (!settings.inputMode) settings.inputMode = m;
  for (const btn of document.querySelectorAll('#screen-mode .mode-btn')) {
    btn.querySelector('.mode-badge').hidden = btn.dataset.mode !== m;
  }
  const reason = cameraUnavailableReason();
  if (reason) {
    document.getElementById('mode-note').textContent = `※ カメラモードは使用できません: ${reason}`;
  }
});

// ---- 入力モード選択 ----
for (const btn of document.querySelectorAll('#screen-mode .mode-btn')) {
  btn.addEventListener('click', () => {
    settings.inputMode = btn.dataset.mode;
    saveSettings();
    syncSettingsUi();
    showScreen('song');
  });
}

// ---- 曲選択 ----
ui.bind('btn-demo', () => loadDemo());

const fileInput = document.getElementById('file-input');
document.getElementById('file-label').hidden = false;
document.getElementById('drm-note').hidden = false;
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (file) loadFile(file);
  fileInput.value = '';
});

async function loadDemo() {
  ui.songError('');
  document.getElementById('song-info').hidden = true;
  ui.setProgress(0.3, 'デモ曲を生成中…(Tone.js)');
  try {
    const short = params.get('song') === 'short';
    const demo = await renderDemoSong({ short });
    state.song = {
      type: 'demo',
      ...demo,
      onsets: beatsFromBpm(demo.bpm, demo.offset, demo.duration),
    };
    ui.hideProgress();
    showSongInfo('生成成功');
  } catch (e) {
    ui.hideProgress();
    ui.songError(e.message || String(e));
  }
}

async function loadFile(file) {
  ui.songError('');
  document.getElementById('song-info').hidden = true;
  ui.setProgress(0.03, `読み込み中: ${file.name}`);
  try {
    const arrayBuffer = await file.arrayBuffer();
    let buffer;
    try {
      buffer = await audio.decodeData(arrayBuffer);
    } catch {
      throw new Error(
        `「${file.name}」をデコードできませんでした。` +
        'DRM保護された曲(Apple Music のサブスク曲など)は使用できません。' +
        '対応形式: mp3 / m4a / aac / wav / mp4・mov(音声トラック)');
    }
    ui.setProgress(0.1, 'デコード成功。ビート解析中…');
    const analysis = await analyzeInWorker(buffer, (r, label) => {
      ui.setProgress(0.1 + r * 0.88, `解析中: ${label}`);
    });
    if (!analysis.bpm) {
      throw new Error('ビートを検出できませんでした。テンポの明瞭な別の曲でお試しください。');
    }
    state.song = {
      type: 'file',
      name: file.name,
      buffer,
      bpm: analysis.bpm,
      offset: analysis.offset,
      duration: buffer.duration,
      onsets: analysis.quantized,
    };
    ui.hideProgress();
    showSongInfo(`デコード成功(${buffer.duration.toFixed(0)}秒 / ${buffer.numberOfChannels}ch)`);
  } catch (e) {
    ui.hideProgress();
    ui.songError(e.message || String(e));
  }
}

/** 解析は Web Worker で実行(UI をブロックしない) */
function analyzeInWorker(buffer, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(new Error('解析ワーカーを起動できませんでした: ' + e.message));
      return;
    }
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error('解析処理でエラーが発生しました: ' + (e.message || '不明')));
    };
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress(msg.ratio, msg.label);
      else if (msg.type === 'result') { worker.terminate(); resolve(msg.result); }
      else if (msg.type === 'error') { worker.terminate(); reject(new Error(msg.message)); }
    };
    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) {
      channels.push(buffer.getChannelData(i).slice().buffer);
    }
    worker.postMessage({ channels, sampleRate: buffer.sampleRate }, channels);
  });
}

/** 解析グリッドの微調整(プレビューで合わせたズレ)込みのオフセット */
function songOffset() {
  const s = state.song;
  return s.offset + (s.nudgeMs ?? 0) / 1000;
}

function currentChart(difficulty = state.difficulty) {
  const s = state.song;
  const nudge = (s.nudgeMs ?? 0) / 1000;
  return generateChart({
    duration: s.duration,
    bpm: s.bpm,
    offset: songOffset(),
    onsets: (s.onsets || []).map((o) => ({ ...o, time: o.time + nudge })),
    density: settings.density,
    difficulty,
    seed: hashStr(s.name),
  });
}

function showSongInfo(decodeMsg) {
  const s = state.song;
  document.getElementById('song-name').textContent = s.name;
  const count = currentChart('normal').length;
  document.getElementById('song-meta').textContent =
    `${decodeMsg} ／ 推定BPM ${s.bpm.toFixed(1)} ／ ノーツ数 ${count}(密度: ${({ low: '少なめ', normal: '普通', high: '多め' })[settings.density]})`;
  document.getElementById('song-info').hidden = false;
  document.getElementById('btn-preview').hidden = false;
}

// 密度セレクタ
for (const btn of document.querySelectorAll('#density-seg .seg-btn')) {
  btn.addEventListener('click', () => {
    settings.density = btn.dataset.density;
    saveSettings();
    for (const b of document.querySelectorAll('#density-seg .seg-btn')) {
      b.classList.toggle('is-active', b === btn);
    }
    if (state.song) showSongInfo('準備完了');
  });
}

ui.bind('btn-to-difficulty', () => {
  if (state.song) showScreen('difficulty');
});

// ---- 解析プレビュー(ビート位置でクリック音) ----
let previewCleanup = null;
ui.bind('btn-preview', () => startPreview());
ui.bind('btn-preview-stop', () => stopPreview());

function startPreview() {
  const s = state.song;
  if (!s) return;
  showScreen('preview');
  const ctx = audio.ensure();
  const startAt = ctx.currentTime + 0.4;
  const beat = 60 / s.bpm;
  const offset = songOffset();
  // 全ビートのクリックを AudioContext に予約(setTimeout 不使用)。
  // 停止時にまとめて消せるよう専用バスに出力する。
  const clickBus = audio.createBus();
  let n = 0;
  for (let k = 0, t = offset; t < s.duration; k++, t = offset + k * beat) {
    if (t < 0) continue;
    audio.click(startAt + t, k % 4 === 0, clickBus.node);
    n++;
  }
  const nudge = s.nudgeMs ?? 0;
  document.getElementById('preview-status').textContent =
    `推定BPM ${s.bpm.toFixed(1)} ／ ビート数 ${n} ／ 微調整 ${nudge > 0 ? '+' : ''}${nudge}ms`;
  const handle = audio.playBufferAt(s.buffer, startAt, { onended: () => stopPreview() });
  const lamp = document.getElementById('beat-lamp');
  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const t = ctx.currentTime - startAt - offset;
    const phase = ((t / beat) % 1 + 1) % 1;
    lamp.classList.toggle('on', t >= 0 && phase < 0.18);
  };
  raf = requestAnimationFrame(loop);
  previewCleanup = () => {
    cancelAnimationFrame(raf);
    handle.stop();
    clickBus.stop(); // 予約済みのクリック音もまとめて止める
    lamp.classList.remove('on');
  };
}

/** グリッド微調整: プレビュー再生中なら新しい値で自動的にかけ直す */
function nudgeGrid(deltaMs) {
  const s = state.song;
  if (!s) return;
  s.nudgeMs = Math.max(-200, Math.min(200, (s.nudgeMs ?? 0) + deltaMs));
  if (previewCleanup) { previewCleanup(); previewCleanup = null; }
  startPreview();
}
ui.bind('btn-nudge-early', () => nudgeGrid(-20));
ui.bind('btn-nudge-late', () => nudgeGrid(20));

function stopPreview() {
  if (previewCleanup) { previewCleanup(); previewCleanup = null; }
  if (ui.current === 'preview') showScreen('song');
}

// ---- タイミング校正(タップで端末の音の遅れを測る) ----
let calibCleanup = null;
let calibReturnScreen = 'mode';

function startCalibration() {
  if (ui.current !== 'calibration') {
    calibReturnScreen = ['song', 'mode', 'difficulty', 'result'].includes(ui.current) ? ui.current : 'mode';
  }
  document.getElementById('settings-modal').hidden = true;
  showScreen('calibration');

  const ctx = audio.ensure();
  const bus = audio.createBus();
  const beat = 0.6; // 100 BPM
  const first = ctx.currentTime + 1.2;
  const totalBeats = 20;
  for (let i = 0; i < totalBeats; i++) {
    audio.beep(first + i * beat, { freq: 880, dur: 0.08, gain: 0.4, out: bus.node });
  }

  const statusEl = document.getElementById('calib-status');
  const lamp = document.getElementById('calib-lamp');
  const doneBtn = document.getElementById('btn-calib-done');
  const retryBtn = document.getElementById('btn-calib-retry');
  doneBtn.hidden = true;
  retryBtn.hidden = true;
  statusEl.textContent = 'まもなく音が始まります…';

  const PRACTICE = 2;
  const NEEDED = 8;
  const taps = [];
  let result = null;

  const onTap = (e) => {
    if (e.target.closest('button')) return; // ボタン操作は計測しない
    const now = audio.now;
    const k = Math.round((now - first) / beat);
    if (k < 0 || k >= totalBeats || result !== null) return;
    const diff = (now - (first + k * beat)) * 1000;
    if (Math.abs(diff) > 280) return; // ビートから離れすぎたタップは無視
    taps.push(diff);
    const measured = Math.max(0, taps.length - PRACTICE);
    if (taps.length <= PRACTICE) {
      statusEl.textContent = `練習 ${taps.length}/${PRACTICE}`;
    } else if (measured < NEEDED) {
      statusEl.textContent = `計測中 ${measured}/${NEEDED}`;
    }
    if (measured >= NEEDED) {
      const samples = taps.slice(PRACTICE).sort((a, b) => a - b);
      result = Math.round(samples[Math.floor(samples.length / 2)] / 10) * 10;
      statusEl.textContent = `あなたの端末では音が約 ${result}ms ${result >= 0 ? '遅れて' : '早く'}聞こえています`;
      doneBtn.hidden = false;
      retryBtn.hidden = false;
      bus.stop();
    }
  };
  const onKey = (e) => {
    if (e.code === 'Space') { e.preventDefault(); onTap(e); }
  };
  window.addEventListener('pointerdown', onTap);
  window.addEventListener('keydown', onKey);

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const t = audio.now - first;
    const phase = ((t / beat) % 1 + 1) % 1;
    lamp.classList.toggle('on', t >= 0 && t < totalBeats * beat && phase < 0.18);
  };
  raf = requestAnimationFrame(loop);

  doneBtn.onclick = () => {
    if (result !== null) {
      settings.audioOffsetMs = result;
      saveSettings();
      ui.toast(`タイミング調整を ${result}ms に設定しました`);
    }
    stopCalibration();
  };
  calibCleanup = () => {
    cancelAnimationFrame(raf);
    bus.stop();
    window.removeEventListener('pointerdown', onTap);
    window.removeEventListener('keydown', onKey);
    lamp.classList.remove('on');
    doneBtn.onclick = null;
  };
}

function stopCalibration() {
  if (calibCleanup) { calibCleanup(); calibCleanup = null; }
  showScreen(calibReturnScreen);
}

ui.bind('btn-calibrate', () => startCalibration());
ui.bind('btn-calib-retry', () => { if (calibCleanup) { calibCleanup(); calibCleanup = null; } startCalibration(); });
ui.bind('btn-calib-back', () => stopCalibration());

// ---- 難易度選択 ----
for (const btn of document.querySelectorAll('#screen-difficulty .mode-btn')) {
  btn.addEventListener('click', () => {
    const pm = btn.dataset.playmode;
    if (pm === 'mai') {
      state.playMode = 'mai';
    } else {
      state.playMode = 'timing';
      state.difficulty = pm === 'ranbu' ? 'hard' : 'normal';
    }
    if (settings.inputMode === 'camera') startGuide();
    else beginPlay();
  });
}

// ---- カメラ立ち位置ガイド ----
let guideRaf = 0;
async function startGuide() {
  showScreen('guide');
  const statusEl = document.getElementById('guide-status');
  const startBtn = document.getElementById('btn-guide-start');
  startBtn.disabled = true;
  statusEl.textContent = 'カメラを準備中…';
  try {
    if (input.mode !== 'camera') {
      await input.setMode('camera', {
        videoEl,
        onStatus: (st) => {
          if (st === 'model-loading') statusEl.textContent = '手検出モデルを読み込み中…';
        },
      });
    }
    stage.setCameraMode(true);
    startBtn.disabled = false;
    // ガイド中も手追従の筆を描画してフィードバックする
    let last = performance.now();
    const loop = (now) => {
      guideRaf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      input.update(now);
      const pointers = input.getPointers();
      const hands = pointers.length;
      statusEl.textContent = hands >= 2
        ? '両手を検出しました。準備ができたら始めてください'
        : hands === 1
          ? '片手を検出。もう片方の手も映してください'
          : '手が見えません。上半身と両手が映る位置に立ってください';
      stage.updatePointers(pointers, dt);
      stage.render(dt, now / 1000);
    };
    guideRaf = requestAnimationFrame(loop);
  } catch (e) {
    handleCameraError(e);
  }
}

function stopGuideLoop() {
  if (guideRaf) cancelAnimationFrame(guideRaf);
  guideRaf = 0;
}

ui.bind('btn-guide-start', () => { stopGuideLoop(); beginPlay(); });
ui.bind('btn-guide-back', () => {
  stopGuideLoop();
  teardownCamera();
  showScreen('difficulty');
});

/** カメラ失敗時: 理由を表示してフォールバックを案内する */
function handleCameraError(e) {
  stopGuideLoop();
  teardownCamera();
  const reason = e && e.userMessage ? e.userMessage : (e && e.message) || String(e);
  ui.toast(`カメラを使用できません: ${reason}`, 8000);
  const note = document.getElementById('mode-note');
  note.textContent = `※ カメラ入力に失敗しました: ${reason} — タッチまたはマウスモードをお使いください。`;
  showScreen('mode');
}

function teardownCamera() {
  if (input.mode === 'camera') input.teardown();
  videoEl.hidden = true;
  stage.setCameraMode(false);
}

// ---- プレイ開始 ----
async function beginPlay() {
  const mode = settings.inputMode || 'mouse';
  try {
    if (input.mode !== mode) {
      await input.setMode(mode, { videoEl });
    }
  } catch (e) {
    handleCameraError(e);
    return;
  }
  const isCamera = mode === 'camera';
  const isMai = state.playMode === 'mai';
  videoEl.hidden = !isCamera;
  stage.setCameraMode(isCamera);
  stage.setLaneGuides(!isMai && mode === 'mouse');
  document.getElementById('lane-labels').hidden = isMai || mode !== 'mouse';
  document.getElementById('mai-gauge').hidden = !isMai;
  showScreen('play');
  ui.setHud({ score: 0, combo: 0, progress: 0 });
  if (isMai) {
    ui.setGauge(0, false);
    const s = state.song;
    game.start({
      buffer: s.buffer,
      strokes: generateStrokeChart({
        duration: s.duration,
        bpm: s.bpm,
        offset: songOffset(),
        density: settings.density,
        seed: hashStr(s.name),
      }),
      duration: s.duration,
      playMode: 'mai',
      meta: { bpm: s.bpm, offset: songOffset() },
    });
  } else {
    game.start({
      buffer: state.song.buffer,
      chart: currentChart(),
      duration: state.song.duration,
    });
  }
}

ui.bind('btn-quit', () => {
  game.stop(false);
  ui.countdown(null);
  teardownCamera();
  showScreen('song');
});

// ---- リザルト ----
function showResult(results) {
  document.getElementById('result-rank').textContent = results.rank;
  document.getElementById('result-score').textContent = String(results.score);
  document.getElementById('result-perfect').textContent = String(results.counts.perfect);
  document.getElementById('result-good').textContent = String(results.counts.good);
  document.getElementById('result-miss').textContent = String(results.counts.miss);
  document.getElementById('result-maxcombo').textContent = String(results.maxCombo);
  const beatRow = document.getElementById('result-beat-row');
  beatRow.hidden = results.playMode !== 'mai';
  document.getElementById('result-beat').textContent = String(results.beatHits ?? 0);
  window.__kagemai.lastResult = results;
  showScreen('result');
}

ui.bind('btn-retry', () => beginPlay());
ui.bind('btn-to-song', () => {
  teardownCamera();
  showScreen('song');
});

// ---- 設定 ----
ui.bind('btn-settings', () => {
  syncSettingsUi();
  document.getElementById('settings-modal').hidden = false;
});
ui.bind('btn-settings-close', () => {
  document.getElementById('settings-modal').hidden = true;
});

function syncSettingsUi() {
  for (const b of document.querySelectorAll('#settings-mode-seg .seg-btn')) {
    b.classList.toggle('is-active', b.dataset.mode === settings.inputMode);
  }
  for (const b of document.querySelectorAll('#settings-hitsound-seg .seg-btn')) {
    b.classList.toggle('is-active', b.dataset.hitsound === settings.hitSound);
  }
  for (const b of document.querySelectorAll('#settings-theme-seg .seg-btn')) {
    b.classList.toggle('is-active', b.dataset.theme === settings.theme);
  }
  const slider = document.getElementById('window-slider');
  slider.value = String(settings.judgeWindowMs);
  document.getElementById('window-value').textContent = `±${settings.judgeWindowMs}ms`;
  const hitvol = document.getElementById('hitvol-slider');
  hitvol.value = String(settings.hitVolume);
  document.getElementById('hitvol-value').textContent = `${settings.hitVolume}%`;
  const camlat = document.getElementById('camlat-slider');
  camlat.value = String(settings.cameraLatencyMs);
  document.getElementById('camlat-value').textContent = `${settings.cameraLatencyMs}ms`;
  const offset = document.getElementById('offset-slider');
  offset.value = String(settings.audioOffsetMs);
  document.getElementById('offset-value').textContent = `${settings.audioOffsetMs}ms`;
  document.getElementById('debug-toggle').checked = settings.debug;
}

document.getElementById('camlat-slider').addEventListener('input', (e) => {
  settings.cameraLatencyMs = Number(e.target.value);
  document.getElementById('camlat-value').textContent = `${settings.cameraLatencyMs}ms`;
  saveSettings();
});
document.getElementById('offset-slider').addEventListener('input', (e) => {
  settings.audioOffsetMs = Number(e.target.value);
  document.getElementById('offset-value').textContent = `${settings.audioOffsetMs}ms`;
  saveSettings();
});

document.getElementById('hitvol-slider').addEventListener('input', (e) => {
  settings.hitVolume = Number(e.target.value);
  document.getElementById('hitvol-value').textContent = `${settings.hitVolume}%`;
  saveSettings();
});
// スライダーを離した時に現在の音量で試聴
document.getElementById('hitvol-slider').addEventListener('change', () => {
  audio.hitSound(settings.hitSound === 'none' ? 'suzu' : settings.hitSound, 'perfect', settings.hitVolume / 100);
});

for (const b of document.querySelectorAll('#settings-hitsound-seg .seg-btn')) {
  b.addEventListener('click', () => {
    settings.hitSound = b.dataset.hitsound;
    saveSettings();
    syncSettingsUi();
    audio.hitSound(settings.hitSound, 'perfect', settings.hitVolume / 100); // 試聴
  });
}

/** 背景テーマを UI(CSS変数)と WebGL 背景の両方に適用する */
function applyTheme() {
  document.body.dataset.theme = settings.theme;
  stage.setTheme(settings.theme);
}

for (const b of document.querySelectorAll('#settings-theme-seg .seg-btn')) {
  b.addEventListener('click', () => {
    settings.theme = b.dataset.theme;
    saveSettings();
    syncSettingsUi();
    applyTheme();
  });
}

for (const b of document.querySelectorAll('#settings-mode-seg .seg-btn')) {
  b.addEventListener('click', () => {
    settings.inputMode = b.dataset.mode;
    saveSettings();
    if (input.mode && input.mode !== settings.inputMode) input.teardown();
    syncSettingsUi();
  });
}
document.getElementById('window-slider').addEventListener('input', (e) => {
  settings.judgeWindowMs = Number(e.target.value);
  document.getElementById('window-value').textContent = `±${settings.judgeWindowMs}ms`;
  saveSettings();
});
document.getElementById('debug-toggle').addEventListener('change', (e) => {
  settings.debug = e.target.checked;
  ui.setDebugVisible(settings.debug);
  saveSettings();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'F2') {
    settings.debug = !settings.debug;
    ui.setDebugVisible(settings.debug);
    saveSettings();
  }
});

// ---- ユーティリティ ----
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---- 起動 ----
document.getElementById('version-tag').textContent = `影舞 ${VERSION}`;
applyTheme();
ui.setDebugVisible(settings.debug);
showScreen('title');
