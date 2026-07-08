// kagemai — ゲーム本体
// タイミングは全て AudioContext.currentTime 基準。
// songTime = ctx.currentTime - songStartAt を毎フレーム計算して描画・判定する
// (setTimeout / フレーム数によるタイミング管理は行わない)。

import {
  JUDGE, judgeNoteHit, judgeTiming, isNoteExpired,
  scoreForJudge, maxPossibleScore, rankForRatio,
} from './core/judge.js';
import { LANE_COUNT } from './input.js';

const LEAD_TIME = 1.8;       // ノーツ出現から判定プレーン到達までの秒数
const COUNT_IN = 3.4;        // カウントダウン秒数
const POINTER_COOLDOWN = 0.1; // 同一ポインタの連続ヒット間隔

export class Game {
  /**
   * deps: {audio: AudioEngine, input: InputManager, stage: Stage, callbacks}
   * callbacks: onJudge(judge, note), onHud(state), onCountdown(n|null),
   *            onFinish(results), onDebug(text)
   */
  constructor({ audio, input, stage, callbacks, settings }) {
    this.audio = audio;
    this.input = input;
    this.stage = stage;
    this.cb = callbacks;
    this.settings = settings;
    this.running = false;
    this._raf = 0;
  }

  get windows() {
    const good = (this.settings.judgeWindowMs ?? 150) / 1000;
    if (this.input.mode === 'camera') {
      // カメラは体を動かす入力なのでタップより甘くする
      return { perfect: Math.min(good * 0.6, 0.1), good: good * 1.2 };
    }
    return { perfect: good / 3, good }; // 既定: good=±150ms, perfect=±50ms
  }

  /** カメラ+手検出パイプラインの遅延補正(秒)。カメラモード以外は 0 */
  get inputLatency() {
    return this.input.mode === 'camera' ? (this.settings.cameraLatencyMs ?? 100) / 1000 : 0;
  }

  get judgeRadius() {
    const base = this.settings.judgeRadius ?? 0.09;
    return this.input.mode === 'camera' ? base * 1.35 : base;
  }

  start({ buffer, chart, duration }) {
    this.stop(false);
    const ctx = this.audio.ensure();

    this.chart = chart.map((n) => ({ ...n, judged: null }));
    this.duration = duration ?? buffer.duration;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { perfect: 0, good: 0, miss: 0 };
    this._nextIdx = 0;
    this._live = [];
    this._lastCount = null;
    this._pointerLock = new Map(); // pointerId -> 最終ヒット時刻
    this._fps = { frames: 0, t: 0, value: 0 };

    this.songStartAt = ctx.currentTime + COUNT_IN;
    this.handle = this.audio.playBufferAt(buffer, this.songStartAt);

    // カウントダウンの音(拍に合わせて3回+開始音)。
    // 中断時に予約分もまとめて止められるよう専用バスに出力する。
    this._beepBus = this.audio.createBus();
    for (let i = 3; i >= 1; i--) {
      this.audio.beep(this.songStartAt - i * 1.0, { freq: 660, dur: 0.1, gain: 0.2, out: this._beepBus.node });
    }
    this.audio.beep(this.songStartAt, { freq: 1320, dur: 0.15, gain: 0.25, out: this._beepBus.node });

    this.input.onLaneKey = (lane) => this._handleLaneKey(lane);

    this.running = true;
    this._lastT = performance.now();
    this._elapsed = 0;
    const loop = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      this._tick(now);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop(fireCallback = true) {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.running = false;
    if (this.handle) { this.handle.stop(); this.handle = null; }
    if (this._beepBus) { this._beepBus.stop(); this._beepBus = null; }
    if (this.input) this.input.onLaneKey = null;
    if (this.stage) this.stage.clearNotes();
    if (fireCallback && this.cb.onQuit) this.cb.onQuit();
  }

  get songTime() {
    return this.audio.now - this.songStartAt;
  }

  _tick(nowMs) {
    const dt = Math.min(0.1, (nowMs - this._lastT) / 1000);
    this._lastT = nowMs;
    this._elapsed += dt;

    // FPS計測
    const f = this._fps;
    f.frames++;
    f.t += dt;
    if (f.t >= 0.5) { f.value = Math.round(f.frames / f.t); f.frames = 0; f.t = 0; }

    const t = this.songTime;
    const W = this.windows;

    // カウントダウン表示
    if (t < 0) {
      const n = Math.ceil(-t);
      if (n !== this._lastCount) { this._lastCount = n; this.cb.onCountdown(Math.min(n, 3)); }
    } else if (this._lastCount !== null) {
      this._lastCount = null;
      this.cb.onCountdown(null);
    }

    // 入力更新
    this.input.update(nowMs);
    const pointers = this.input.getPointers();
    const aspect = this.input.aspect;

    // ノーツのライブ集合を更新
    while (this._nextIdx < this.chart.length && this.chart[this._nextIdx].time - LEAD_TIME <= t) {
      this._live.push(this.chart[this._nextIdx++]);
    }

    // 判定。カメラモードでは映像+検出の遅延ぶん過去の出来事として扱う
    const judgeTime = t - this.inputLatency;
    if (t >= 0) {
      for (const p of pointers) {
        if (!p.active) continue;
        const lockT = this._pointerLock.get(p.id) ?? -Infinity;
        if (t - lockT < POINTER_COOLDOWN) continue;
        let best = null;
        for (const n of this._live) {
          if (n.judged) continue;
          const hit = judgeNoteHit(n, p, judgeTime, {
            windows: W,
            radius: this.judgeRadius,
            aspect,
            minSwipeSpeed: this.settings.minSwipeSpeed ?? 1.0,
          });
          if (hit && (!best || n.time < best.note.time)) best = { note: n, ...hit };
        }
        if (best) {
          this._pointerLock.set(p.id, t);
          this._applyJudge(best.note, best.judge);
        }
      }
    }

    // Miss確定(遅延補正後の時刻基準。補正ぶんだけ判定チャンスが残る)
    for (const n of this._live) {
      if (!n.judged && isNoteExpired(n.time, judgeTime, W)) {
        this._applyJudge(n, JUDGE.MISS);
      }
    }
    this._live = this._live.filter((n) => !n.judged);

    // 描画
    this.stage.syncNotes(this._live, t, LEAD_TIME);
    this.stage.updatePointers(pointers, dt);
    this.stage.render(dt, this._elapsed);

    // HUD
    this.cb.onHud({
      score: this.score,
      combo: this.combo,
      progress: Math.max(0, Math.min(1, t / this.duration)),
    });
    if (this.cb.onDebug) {
      const latency = this.inputLatency > 0 ? `  遅延補正 ${Math.round(this.inputLatency * 1000)}ms` : '';
      this.cb.onDebug(`FPS ${f.value}  入力: ${this.input.mode}  ポインタ: ${pointers.length}${latency}\n` +
        `t=${t.toFixed(2)}s  残ノーツ ${this.chart.length - this.counts.perfect - this.counts.good - this.counts.miss}`);
    }

    // 終了判定
    if (t > this.duration + 0.6) {
      this._finish();
    }
  }

  /** キーボードレーン入力(D/F/J/K)。押下時刻の音声時計で判定する。 */
  _handleLaneKey(lane) {
    const t = this.songTime;
    if (t < 0) return;
    const W = this.windows;
    let best = null;
    for (const n of this._live) {
      if (n.judged) continue;
      if (Math.floor(n.x * LANE_COUNT) !== lane) continue;
      const dt = t - n.time;
      const j = judgeTiming(dt, W);
      if (j && (!best || Math.abs(dt) < Math.abs(best.dt))) best = { note: n, judge: j, dt };
    }
    if (best) this._applyJudge(best.note, best.judge);
  }

  _applyJudge(note, judge) {
    note.judged = judge;
    if (judge === JUDGE.MISS) {
      this.combo = 0;
      this.counts.miss++;
    } else {
      this.score += scoreForJudge(judge, this.combo);
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.counts[judge]++;
    }
    this.audio.hitSound(this.settings.hitSound, judge, (this.settings.hitVolume ?? 80) / 100);
    this.stage.hitFx(note.x, note.y, judge);
    this.cb.onJudge(judge, note);
  }

  _finish() {
    const total = this.chart.length;
    const max = maxPossibleScore(total);
    const ratio = max > 0 ? this.score / max : 0;
    const results = {
      score: this.score,
      maxCombo: this.maxCombo,
      counts: this.counts,
      total,
      ratio,
      rank: rankForRatio(ratio),
    };
    this.stop(false);
    this.cb.onFinish(results);
  }
}
