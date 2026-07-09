// kagemai — ゲーム本体
// タイミングは全て AudioContext.currentTime 基準。
// songTime = ctx.currentTime - songStartAt を毎フレーム計算して描画・判定する
// (setTimeout / フレーム数によるタイミング管理は行わない)。

import {
  JUDGE, judgeNoteHit, judgeTiming, isNoteExpired, isPointerOnNote,
  scoreForJudge, maxPossibleScore, rankForRatio,
} from './core/judge.js';
import { sampleStroke, strokeGrade, beatIndex } from './core/stroke.js';
import { LANE_COUNT } from './input.js';

const LEAD_TIME = 1.8;       // ノーツ出現から判定プレーン到達までの秒数
const COUNT_IN = 3.4;        // カウントダウン秒数
const POINTER_COOLDOWN = 0.1; // 同一ポインタの連続ヒット間隔

// 舞モード(なぞり)
const STROKE_APPEAR = 1.2;    // ストロークが薄く現れてから始まるまでの秒数
const STROKE_SLACK = 0.35;    // 終了後になぞりを受け付ける猶予
const STROKE_SAMPLES = 20;    // 経路のサンプル数(カバー率の分母)
const BEAT_HIT_SPEED = 1.1;   // 拍合ボーナスに必要なポインタ速度

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

  /**
   * playMode: 'timing'(律/乱舞: 従来のタイミング判定)| 'mai'(舞: なぞり)
   * timing では chart(ノーツ配列)、mai では strokes(ストローク配列)と
   * meta {bpm, offset}(拍パルス・拍合用)を渡す。
   */
  start({ buffer, chart = [], strokes = [], duration, playMode = 'timing', meta = null }) {
    this.stop(false);
    const ctx = this.audio.ensure();

    this.playMode = playMode;
    this.meta = meta;
    this.chart = chart.map((n) => ({ ...n, judged: null }));
    this.strokes = strokes.map((s) => ({
      stroke: s,
      samples: sampleStroke(s.points, STROKE_SAMPLES),
      covered: new Uint8Array(STROKE_SAMPLES),
      judged: null,
    }));
    this.duration = duration ?? buffer.duration;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { perfect: 0, good: 0, miss: 0 };
    this.beatHits = 0;
    this.gauge = 0;
    this.fever = false;
    this._lastBeatK = -1;
    this._hlActive = false;
    this._hlPeakFired = new Set(); // 発火済みの高揚区間ピーク
    this._nextIdx = 0;
    this._live = [];
    this._liveStrokes = [];
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
    if (this.stage) {
      this.stage.clearNotes();
      this.stage.clearStrokes();
      this.stage.setFever(false);
      this.stage.setHighlight(false);
      this.stage.setMusicLevel(0);
    }
    if (fireCallback && this.cb.onQuit) this.cb.onQuit();
  }

  get songTime() {
    // タイミング調整(校正値): 正の値 = 音が遅れて聞こえる端末。
    // ゲーム時間全体(出現・描画・判定)を「耳に届く音」に合わせてずらす。
    return this.audio.now - this.songStartAt - (this.settings.audioOffsetMs ?? 0) / 1000;
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

    if (this.playMode === 'mai') {
      this._tickMai(t, dt, pointers, aspect);
    } else {
      this._tickTiming(t, pointers, aspect, W);
    }
    this._tickFx(t);

    this.stage.updatePointers(pointers, dt);
    this.stage.render(dt, this._elapsed);

    // HUD
    const hud = {
      score: this.score,
      combo: this.combo,
      progress: Math.max(0, Math.min(1, t / this.duration)),
    };
    if (this.playMode === 'mai') {
      hud.gauge = this.gauge;
      hud.fever = this.fever;
    }
    this.cb.onHud(hud);
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

  /** 律/乱舞: 従来のタイミング判定 */
  _tickTiming(t, pointers, aspect, W) {
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
          if (!hit) continue;
          // カメラ(常時接触)では「置いて待つ」手が窓の開いた瞬間に
          // 早取りしないよう、perfect窓より早いヒットは見送る
          if (this.input.mode === 'camera' && hit.dt < -W.perfect) continue;
          if (!best || n.time < best.note.time) best = { note: n, ...hit };
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
    this.stage.syncNotes(this._live, t, LEAD_TIME);
  }

  /** 舞: なぞり(カバー率)判定+拍合ボーナス+舞ゲージ */
  _tickMai(t, dt, pointers, aspect) {
    while (this._nextIdx < this.strokes.length &&
           this.strokes[this._nextIdx].stroke.tStart - STROKE_APPEAR <= t) {
      this._liveStrokes.push(this.strokes[this._nextIdx++]);
    }

    const radius = this.judgeRadius * 1.3;
    for (const ls of this._liveStrokes) {
      if (ls.judged) continue;
      const { tStart, tEnd } = ls.stroke;
      if (t < tStart - 0.15) continue;
      if (t <= tEnd + STROKE_SLACK) {
        // なぞり中: ポインタが触れたサンプルを塗っていく
        for (const p of pointers) {
          if (!p.active) continue;
          for (let i = 0; i < ls.samples.length; i++) {
            if (ls.covered[i]) continue;
            const s = ls.samples[i];
            if (isPointerOnNote(p.x, p.y, s.x, s.y, radius, aspect)) ls.covered[i] = 1;
          }
        }
      } else {
        // 締め切り: カバー率で評価を確定
        let c = 0;
        for (const v of ls.covered) c += v;
        this._applyStrokeGrade(ls, strokeGrade(c / ls.covered.length));
      }
    }
    this._liveStrokes = this._liveStrokes.filter((ls) => !ls.judged);

    // 拍パルスと拍合ボーナス(拍の瞬間に手が動いていれば加点)
    if (t >= 0 && this.meta) {
      const k = beatIndex(t, this.meta.bpm, this.meta.offset);
      if (k !== this._lastBeatK) {
        this._lastBeatK = k;
        this.stage.beatPulse();
        const mover = pointers.find((p) => p.active && Math.hypot(p.vx, p.vy) > BEAT_HIT_SPEED);
        if (mover) {
          this.beatHits++;
          this.score += Math.round(20 * (this.fever ? 1.5 : 1));
          this.gauge = Math.min(1, this.gauge + 0.03);
          if (this.cb.onBeatHit) this.cb.onBeatHit(mover);
        }
      }
    }

    // 舞ゲージ: 満タンでフィーバー、フィーバー中は消費
    if (this.fever) {
      this.gauge -= dt / 8;
      if (this.gauge <= 0) {
        this.gauge = 0;
        this.fever = false;
        this.stage.setFever(false);
      }
    } else {
      this.gauge = Math.max(0, this.gauge - dt * 0.03);
      if (this.gauge >= 1) {
        this.fever = true;
        this.stage.setFever(true);
      }
    }

    this.stage.syncStrokes(this._liveStrokes, t, STROKE_APPEAR);
  }

  /** 演出: 音楽反応背景と華の刻(高揚区間)・花火 */
  _tickFx(t) {
    const m = this.meta;
    if (!m) return;

    // 背景の呼吸(エネルギータイムライン)
    if (m.energy && m.energyRate) {
      const i = Math.floor(t * m.energyRate);
      this.stage.setMusicLevel(t >= 0 && i >= 0 && i < m.energy.length ? m.energy[i] : 0);
    }

    // 華の刻: 高揚区間に入ると桜吹雪、ピークで花火
    if (m.highlights && m.highlights.length) {
      const region = t >= 0 ? m.highlights.find((h) => t >= h.start && t < h.end) : null;
      const active = !!region;
      if (active !== this._hlActive) {
        this._hlActive = active;
        this.stage.setHighlight(active);
      }
      if (region && !this._hlPeakFired.has(region.peak) && t >= region.peak) {
        this._hlPeakFired.add(region.peak);
        this.stage.fireworks(3);
        this.audio.boom();
      }
    }

    // 動的品質: FPS が落ちたら演出負荷と解像度を下げる
    const fps = this._fps.value;
    if (fps > 0) {
      if (fps < 40 && this.stage.quality > 0.5) this.stage.setQuality(0.5);
      else if (fps > 54 && this.stage.quality < 1) this.stage.setQuality(1);
    }
  }

  _applyStrokeGrade(ls, grade) {
    ls.judged = grade;
    const mult = this.fever ? 1.5 : 1;
    if (grade === JUDGE.MISS) {
      this.combo = 0;
      this.counts.miss++;
      this.gauge = Math.max(0, this.gauge - 0.12);
    } else {
      this.score += Math.round(3 * scoreForJudge(grade, this.combo) * mult);
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.counts[grade]++;
      this.gauge = Math.min(1, this.gauge + (grade === JUDGE.PERFECT ? 0.15 : 0.08));
    }
    const end = ls.samples[ls.samples.length - 1];
    this.audio.hitSound(this.settings.hitSound, grade, (this.settings.hitVolume ?? 80) / 100);
    this.stage.hitFx(end.x, end.y, grade);
    this.cb.onJudge(grade, { x: end.x, y: end.y });
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
    const isMai = this.playMode === 'mai';
    const total = isMai ? this.strokes.length : this.chart.length;
    const max = (isMai ? 3 : 1) * maxPossibleScore(total);
    const ratio = max > 0 ? Math.min(1, this.score / max) : 0;
    const results = {
      score: this.score,
      maxCombo: this.maxCombo,
      counts: this.counts,
      total,
      ratio,
      rank: rankForRatio(ratio),
      playMode: this.playMode,
      beatHits: this.beatHits,
    };
    this.stop(false);
    this.cb.onFinish(results);
  }
}
