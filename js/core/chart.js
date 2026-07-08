// kagemai — 譜面生成コア(純粋関数のみ)
// ビートグリッド/量子化オンセットからノーツ配列を生成する。

/** 決定的な乱数生成器 (mulberry32) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DENSITY = Object.freeze({
  low: { label: '少なめ', gapBeats: 1.8, useHalf: false },
  normal: { label: '普通', gapBeats: 0.9, useHalf: false },
  high: { label: '多め', gapBeats: 0.45, useHalf: true },
});

const SWIPE_DIRS = [
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  { x: 0.707, y: 0.707 }, { x: -0.707, y: 0.707 },
  { x: 0.707, y: -0.707 }, { x: -0.707, y: -0.707 },
];

/**
 * 譜面(ノーツ配列)を生成する。
 * opts:
 *   duration: 曲の長さ(秒) [必須]
 *   bpm, offset: ビートグリッド [必須]
 *   onsets: [{time, strength}] 量子化済みオンセット(省略時は全ビートを候補にする)
 *   density: 'low'|'normal'|'high'
 *   difficulty: 'normal'|'hard'(hard はスワイプノーツ混入)
 *   seed: 乱数シード
 * ノーツ: {id, time, x, y, hand:'L'|'R', type:'tap'|'swipe', dir?}
 */
export function generateChart({
  duration,
  bpm,
  offset = 0,
  onsets = null,
  density = 'normal',
  difficulty = 'normal',
  seed = 7,
  leadIn = 1.8,
  tailOut = 1.0,
}) {
  if (!(bpm > 0) || !(duration > 0)) return [];
  const conf = DENSITY[density] || DENSITY.normal;
  const beat = 60 / bpm;
  const rand = mulberry32(seed);

  // 候補時刻の列挙
  let candidates;
  if (onsets && onsets.length > 0) {
    candidates = onsets.map((o) => ({ time: o.time, strength: o.strength ?? 1 }));
    if (!conf.useHalf) {
      // 半拍候補を間引き: ビート整数位置を優先
      candidates = candidates.filter((c) => {
        const pos = (c.time - offset) / beat;
        return Math.abs(pos - Math.round(pos)) < 0.26 || c.strength > 0.5;
      });
    }
  } else {
    candidates = [];
    const step = conf.useHalf ? beat / 2 : beat;
    for (let t = offset; t < duration; t += step) {
      if (t < 0) continue;
      const pos = (t - offset) / beat;
      const onBeat = Math.abs(pos - Math.round(pos)) < 0.01;
      candidates.push({ time: t, strength: onBeat ? 1 : 0.4 });
    }
  }
  candidates.sort((a, b) => a.time - b.time);

  const minGap = beat * conf.gapBeats * 0.98;
  const notes = [];
  let lastTime = -Infinity;
  let handFlip = rand() < 0.5;
  const lastPos = { L: { x: 0.3, y: 0.5 }, R: { x: 0.7, y: 0.5 } };
  let id = 0;

  for (const c of candidates) {
    if (c.time < leadIn || c.time > duration - tailOut) continue;
    if (c.time - lastTime < minGap) continue;

    handFlip = !handFlip;
    const hand = handFlip ? 'R' : 'L';
    const prev = lastPos[hand];

    // 前回位置からのランダムウォーク(手の可動域内)
    const xMin = hand === 'L' ? 0.12 : 0.52;
    const xMax = hand === 'L' ? 0.48 : 0.88;
    const step = 0.28;
    const x = clamp(prev.x + (rand() * 2 - 1) * step, xMin, xMax);
    const y = clamp(prev.y + (rand() * 2 - 1) * step, 0.22, 0.72);
    lastPos[hand] = { x, y };

    const note = { id: id++, time: c.time, x, y, hand, type: 'tap' };
    if (difficulty === 'hard' && rand() < 0.3) {
      note.type = 'swipe';
      note.dir = SWIPE_DIRS[Math.floor(rand() * SWIPE_DIRS.length)];
    }
    notes.push(note);
    lastTime = c.time;
  }
  return notes;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * デモ曲など既知の BPM から等間隔ビート列を作るユーティリティ。
 * ダウンビートは strength 1、その他 0.6。
 */
export function beatsFromBpm(bpm, offset, duration, { perBar = 4 } = {}) {
  const beat = 60 / bpm;
  const out = [];
  let i = 0;
  for (let t = offset; t < duration; t += beat, i++) {
    out.push({ time: t, strength: i % perBar === 0 ? 1 : 0.6 });
  }
  return out;
}
