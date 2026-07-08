// kagemai — オーディオエンジン
// AudioContext の生成/resume は必ずユーザー操作イベント内で ensure() を呼ぶこと。
// 再生タイミングは全て AudioContext.currentTime 基準。

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._current = null; // 再生中の {source, gain}
  }

  /** ユーザー操作イベント内で呼ぶこと */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** ArrayBuffer をデコードする(Safari のコールバック形式にも対応) */
  decodeData(arrayBuffer) {
    const ctx = this.ensure();
    return new Promise((resolve, reject) => {
      const fail = (e) => reject(e instanceof Error ? e : new Error('デコードに失敗しました'));
      try {
        const p = ctx.decodeAudioData(arrayBuffer, resolve, fail);
        if (p && typeof p.then === 'function') p.then(resolve, fail);
      } catch (e) {
        fail(e);
      }
    });
  }

  /**
   * buffer を絶対時刻 when(ctx.currentTime 基準)から再生する。
   * 戻り値ハンドルの stop() で停止。onended は自然終了/停止の両方で呼ばれる。
   */
  playBufferAt(buffer, when, { onended = null } = {}) {
    const ctx = this.ensure();
    this.stopCurrent();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(this.master);
    if (onended) source.onended = onended;
    source.start(Math.max(when, ctx.currentTime));
    const handle = {
      source,
      gain,
      when,
      stop: () => {
        try { source.onended = null; source.stop(); } catch { /* already stopped */ }
        if (this._current === handle) this._current = null;
      },
    };
    this._current = handle;
    return handle;
  }

  stopCurrent() {
    if (this._current) {
      const c = this._current;
      this._current = null;
      try { c.source.onended = null; c.source.stop(); } catch { /* noop */ }
    }
  }

  /** 短いビープ(カウントダウン等)を絶対時刻 time に予約する */
  beep(time, { freq = 880, dur = 0.09, gain = 0.25, type = 'sine' } = {}) {
    const ctx = this.ensure();
    const t = Math.max(time, ctx.currentTime);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** ビート検証用クリック音 */
  click(time, accent = false) {
    this.beep(time, { freq: accent ? 1800 : 1200, dur: 0.04, gain: 0.5, type: 'square' });
  }
}
