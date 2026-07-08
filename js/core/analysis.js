// kagemai — ビート解析コア(純粋関数のみ)
// DOM / AudioContext に依存しない。Float32Array と数値のみを扱う。
// Node のユニットテストから直接 import される。

/** 複数チャンネルをモノラルにミックスダウンする */
export function mixdown(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  const g = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** 単純平均によるデシメーション(低域解析用の前処理) */
export function decimate(samples, factor) {
  if (factor <= 1) return samples;
  const n = Math.floor(samples.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) s += samples[base + j];
    out[i] = s / factor;
  }
  return out;
}

/** RBJ biquad ローパスフィルタ(既定 ~150Hz) */
export function lowpassFilter(samples, sampleRate, cutoff = 150, q = 0.707) {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw0 = Math.cos(w0);
  const b0 = (1 - cosw0) / 2;
  const b1 = 1 - cosw0;
  const b2 = (1 - cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

/** RMS エネルギー包絡線を計算する */
export function energyEnvelope(samples, sampleRate, { frame = 1024, hop = 512 } = {}) {
  const n = Math.max(0, Math.floor((samples.length - frame) / hop) + 1);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * hop;
    for (let j = 0; j < frame; j++) {
      const v = samples[base + j];
      s += v * v;
    }
    env[i] = Math.sqrt(s / frame);
  }
  return { env, hopTime: hop / sampleRate };
}

/**
 * エネルギー包絡線からオンセット(立ち上がり)時刻を検出する。
 * 戻り値: [{time, strength}] (time は秒)
 */
export function detectOnsets(env, hopTime, { minGap = 0.12, sensitivity = 1.5 } = {}) {
  const n = env.length;
  if (n < 4) return [];
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, env[i]);
  if (peak <= 0) return [];

  // 正の一次差分(エネルギー増加分)
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) flux[i] = Math.max(0, env[i] - env[i - 1]) / peak;

  // 局所適応しきい値
  const win = Math.max(4, Math.round(0.7 / hopTime / 2)); // 約±0.35s
  const onsets = [];
  let lastTime = -Infinity;
  for (let i = 2; i < n - 2; i++) {
    const f = flux[i];
    if (f <= 0) continue;
    if (!(f >= flux[i - 1] && f >= flux[i - 2] && f > flux[i + 1] && f > flux[i + 2])) continue;
    let mean = 0, count = 0;
    for (let j = Math.max(1, i - win); j <= Math.min(n - 1, i + win); j++) { mean += flux[j]; count++; }
    mean /= count;
    const threshold = mean * sensitivity + 0.01;
    if (f < threshold) continue;
    const time = i * hopTime;
    if (time - lastTime < minGap) {
      // 近接ピークは強い方を残す
      const prev = onsets[onsets.length - 1];
      if (prev && f > prev.strength) { prev.time = time; prev.strength = f; lastTime = time; }
      continue;
    }
    onsets.push({ time, strength: f });
    lastTime = time;
  }
  return onsets;
}

/**
 * オンセット間隔のヒストグラムから BPM を推定する。
 * 戻り値: {bpm, confidence} — 推定不能なら bpm=0
 */
export function estimateBpm(onsets, { minBpm = 70, maxBpm = 180 } = {}) {
  const times = onsets.map((o) => o.time);
  if (times.length < 4) return { bpm: 0, confidence: 0 };
  const minT = 60 / maxBpm;
  const maxT = 60 / minBpm;

  // 1〜3個先のオンセットとの間隔を採取し、[minT, maxT) にオクターブ折り畳み。
  // 折り畳み次数 k が大きいほど重みを下げる(折り畳みアーティファクト対策)。
  const intervals = [];
  for (let i = 0; i < times.length; i++) {
    for (let k = 1; k <= 3 && i + k < times.length; k++) {
      let d = times[i + k] - times[i];
      if (d < 0.05 || d > 4) continue;
      while (d < minT) d *= 2;
      while (d >= maxT) d /= 2;
      if (d >= minT && d < maxT) intervals.push({ d, w: 1 / k });
    }
  }
  if (intervals.length < 4) return { bpm: 0, confidence: 0 };

  // ガウシアンカーネル密度推定(オンセット時刻の量子化ばらつきを吸収)
  const binW = 0.002;
  const sigma = 0.006;
  const spread = Math.ceil((3 * sigma) / binW);
  const nBins = Math.ceil((maxT - minT) / binW) + 1;
  const hist = new Float32Array(nBins);
  let totalW = 0;
  for (const { d, w } of intervals) {
    totalW += w;
    const c = (d - minT) / binW;
    const ci = Math.round(c);
    for (let b = Math.max(0, ci - spread); b <= Math.min(nBins - 1, ci + spread); b++) {
      const dist = (b - c) * binW;
      hist[b] += w * Math.exp(-(dist * dist) / (2 * sigma * sigma));
    }
  }
  let bestBin = 0, bestVal = -1;
  for (let i = 0; i < nBins; i++) {
    if (hist[i] > bestVal) { bestVal = hist[i]; bestBin = i; }
  }
  // ピーク近傍の間隔を重み付き平均して精密化
  const center = minT + bestBin * binW;
  let sum = 0, wsum = 0;
  for (const { d, w } of intervals) {
    if (Math.abs(d - center) <= sigma * 3) { sum += d * w; wsum += w; }
  }
  if (wsum === 0) return { bpm: 0, confidence: 0 };
  const period = sum / wsum;
  const confidence = wsum / totalW;
  return { bpm: 60 / period, confidence };
}

/**
 * BPM を固定してビートグリッドの位相(offset)を求め、
 * さらに最小二乗でテンポ・位相を微調整する。
 * 戻り値: {bpm, offset, score}
 */
export function fitBeatGrid(onsets, bpm) {
  const times = onsets.map((o) => o.time);
  if (bpm <= 0 || times.length === 0) return { bpm, offset: 0, score: 0 };
  let period = 60 / bpm;

  // 円周平均で位相を推定
  let sinS = 0, cosS = 0;
  for (const t of times) {
    const th = (2 * Math.PI * t) / period;
    sinS += Math.sin(th);
    cosS += Math.cos(th);
  }
  let offset = (Math.atan2(sinS, cosS) / (2 * Math.PI)) * period;
  if (offset < 0) offset += period;

  // 最寄りビートへの割り当て → 線形回帰で period/offset を精密化(2回)
  for (let iter = 0; iter < 2; iter++) {
    let sk = 0, st = 0, skk = 0, skt = 0, m = 0;
    for (const t of times) {
      const k = Math.round((t - offset) / period);
      const err = Math.abs(t - (offset + k * period));
      if (err > period * 0.2) continue; // 外れ値は無視
      sk += k; st += t; skk += k * k; skt += k * t; m++;
    }
    if (m < 3) break;
    const denom = m * skk - sk * sk;
    if (Math.abs(denom) < 1e-9) break;
    const newPeriod = (m * skt - sk * st) / denom;
    const newOffset = (st - newPeriod * sk) / m;
    if (newPeriod > 0.2 && newPeriod < 1.2) { period = newPeriod; offset = newOffset; }
  }

  // グリッドとの整合スコア(0..1)
  let score = 0;
  for (const t of times) {
    const k = Math.round((t - offset) / period);
    const err = Math.abs(t - (offset + k * period));
    score += Math.max(0, 1 - err / (period * 0.25));
  }
  score /= times.length;
  while (offset < 0) offset += period;
  return { bpm: 60 / period, offset: offset % period, score };
}

/**
 * オンセットをビートグリッド(subdivision 分割)に量子化する。
 * 同一グリッドの重複は最大 strength を残す。時刻順に返す。
 */
export function quantizeOnsets(onsets, bpm, offset, subdivision = 2) {
  if (bpm <= 0) return [];
  const step = 60 / bpm / subdivision;
  const map = new Map();
  for (const o of onsets) {
    const k = Math.round((o.time - offset) / step);
    const t = offset + k * step;
    if (t < 0) continue;
    const prev = map.get(k);
    if (!prev || o.strength > prev.strength) map.set(k, { time: t, strength: o.strength, gridIndex: k });
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

/**
 * 一括解析パイプライン。channels: Float32Array[](デコード済みPCM)。
 * onProgress(ratio, label) は任意。
 * 戻り値: {bpm, offset, onsets, quantized, duration, confidence, score}
 */
export function analyzeBuffer(channels, sampleRate, { onProgress = null, minBpm = 70, maxBpm = 180 } = {}) {
  const report = (r, l) => { if (onProgress) onProgress(r, l); };
  const duration = channels[0].length / sampleRate;

  report(0.05, 'ミックスダウン');
  const mono = mixdown(channels);

  report(0.15, 'ダウンサンプリング');
  const factor = Math.max(1, Math.floor(sampleRate / 11025));
  const low = decimate(mono, factor);
  const sr = sampleRate / factor;

  report(0.3, 'ローパスフィルタ');
  const filtered = lowpassFilter(low, sr, 150);

  report(0.5, 'エネルギー包絡線');
  const { env, hopTime } = energyEnvelope(filtered, sr, { frame: 512, hop: 128 });

  report(0.65, 'オンセット検出');
  const onsets = detectOnsets(env, hopTime);

  report(0.8, 'BPM推定');
  const { bpm: rawBpm, confidence } = estimateBpm(onsets, { minBpm, maxBpm });
  if (rawBpm <= 0 || onsets.length < 8) {
    report(1, '解析失敗');
    return { bpm: 0, offset: 0, onsets, quantized: [], duration, confidence: 0, score: 0 };
  }

  report(0.9, 'ビートグリッド適合');
  const grid = fitBeatGrid(onsets, rawBpm);
  const quantized = quantizeOnsets(onsets, grid.bpm, grid.offset, 2);

  report(1, '完了');
  return {
    bpm: grid.bpm,
    offset: grid.offset,
    onsets,
    quantized,
    duration,
    confidence,
    score: grid.score,
  };
}
