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

  /**
   * 予約音(ビープ/クリック)用のバスを作る。
   * 予約済みの音をまとめて止めたい場面では、このバスに出力しておき
   * stop()(=切断)する。オシレータ個別の stop 管理は不要になる。
   */
  createBus() {
    const ctx = this.ensure();
    const gain = ctx.createGain();
    gain.connect(this.master);
    return {
      node: gain,
      stop: () => { try { gain.disconnect(); } catch { /* 切断済み */ } },
    };
  }

  /** 短いビープ(カウントダウン等)を絶対時刻 time に予約する */
  beep(time, { freq = 880, dur = 0.09, gain = 0.25, type = 'sine', out = null } = {}) {
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
    g.connect(out || this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** ビート検証用クリック音 */
  click(time, accent = false, out = null) {
    this.beep(time, { freq: accent ? 1800 : 1200, dur: 0.04, gain: 0.5, type: 'square', out });
  }

  // ---- ヒット効果音(Web Audio 合成・追加アセット不要) ----

  _noise() {
    if (!this._noiseBuf) {
      const ctx = this.ensure();
      const n = Math.floor(ctx.sampleRate * 0.5);
      this._noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const data = this._noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    }
    return this._noiseBuf;
  }

  _envGain(t, peak, decay) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    g.connect(this.master);
    return g;
  }

  _noiseBurst(t, { filterType, freq, q = 1, peak, decay }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    src.connect(f);
    f.connect(this._envGain(t, peak, decay));
    src.start(t);
    src.stop(t + decay + 0.05);
  }

  /**
   * 判定時のヒット効果音を即時再生する。
   * type: 'none' | 'suzu'(鈴) | 'hyoshigi'(拍子木) | 'tsuzumi'(鼓)
   * judge が 'good' のときは控えめに、'miss' は鳴らさない。
   */
  hitSound(type, judge = 'perfect') {
    if (!type || type === 'none' || judge === 'miss') return;
    const ctx = this.ensure();
    const t = ctx.currentTime;
    const vol = judge === 'perfect' ? 1 : 0.55;
    const jitter = () => 1 + (Math.random() - 0.5) * 0.06; // 連打の機械っぽさを消す
    if (type === 'suzu') {
      // 鈴: 非整数倍音のきらめき+高域ノイズの「シャン」
      for (const [freq, g] of [[2731, 0.10], [4053, 0.09], [5197, 0.07], [6423, 0.05]]) {
        const osc = ctx.createOscillator();
        osc.frequency.value = freq * jitter();
        osc.connect(this._envGain(t, g * vol, 0.32));
        osc.start(t);
        osc.stop(t + 0.4);
      }
      this._noiseBurst(t, { filterType: 'highpass', freq: 6000, peak: 0.16 * vol, decay: 0.09 });
    } else if (type === 'hyoshigi') {
      // 拍子木: 短い木質の「カッ」
      this._noiseBurst(t, { filterType: 'bandpass', freq: 2200 * jitter(), q: 6, peak: 0.55 * vol, decay: 0.055 });
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 1150 * jitter();
      osc.connect(this._envGain(t, 0.2 * vol, 0.04));
      osc.start(t);
      osc.stop(t + 0.1);
    } else if (type === 'tsuzumi') {
      // 鼓: 音程が落ちる「ポン」
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(250 * jitter(), t);
      osc.frequency.exponentialRampToValueAtTime(150, t + 0.12);
      osc.connect(this._envGain(t, 0.5 * vol, 0.2));
      osc.start(t);
      osc.stop(t + 0.3);
      this._noiseBurst(t, { filterType: 'lowpass', freq: 900, peak: 0.14 * vol, decay: 0.04 });
    }
  }
}

/** 設定画面で使うヒット音の種類とラベル */
export const HIT_SOUNDS = Object.freeze({
  none: 'なし',
  suzu: '鈴',
  hyoshigi: '拍子木',
  tsuzumi: '鼓',
});
