// kagemai — 舞モード(なぞりノーツ)コア(純粋関数のみ)
// タイミング窓で競うのではなく、「光の筆致をどれだけなぞれたか」で評価する。
// カバー率ベースなので入力遅延の影響を受けにくい。

import { mulberry32 } from './chart.js';

export const STROKE_DENSITY = Object.freeze({
  low: { label: '少なめ', gapBeats: 4, lenBeats: 2.0 },
  normal: { label: '普通', gapBeats: 2, lenBeats: 1.5 },
  high: { label: '多め', gapBeats: 1.5, lenBeats: 1.2 },
});

/** カバー率(0..1)から評価を返す。境界値は上のランクに含む */
export function strokeGrade(coverage) {
  if (coverage >= 0.8) return 'perfect';
  if (coverage >= 0.4) return 'good';
  return 'miss';
}

/** 時刻 t が何拍目か(グリッド基準) */
export function beatIndex(t, bpm, offset = 0) {
  return Math.floor((t - offset) / (60 / bpm));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 2次ベジェ(3制御点)のストローク経路を n 点にサンプリングする。
 * 戻り値: [{x, y, u}](u は経路上の進行度 0..1)
 */
export function sampleStroke(points, n = 20) {
  const [p0, p1, p2] = points;
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : i / (n - 1);
    const a = (1 - u) * (1 - u);
    const b = 2 * (1 - u) * u;
    const c = u * u;
    out.push({
      x: a * p0.x + b * p1.x + c * p2.x,
      y: a * p0.y + b * p1.y + c * p2.y,
      u,
    });
  }
  return out;
}

/**
 * 舞モードの譜面(ストローク配列)を生成する。
 * ストローク: {id, tStart, tEnd, hand:'L'|'R', points:[{x,y}×3]}
 * - ビートグリッドに同期して出現する
 * - 手ごとの可動域内で、滑らかに繋がる2次ベジェ経路を作る
 */
export function generateStrokeChart({
  duration,
  bpm,
  offset = 0,
  density = 'normal',
  seed = 7,
  leadIn = 2.0,
  tailOut = 1.5,
}) {
  if (!(bpm > 0) || !(duration > 0)) return [];
  const conf = STROKE_DENSITY[density] || STROKE_DENSITY.normal;
  const beat = 60 / bpm;
  const rand = mulberry32(seed);

  const strokes = [];
  let handFlip = rand() < 0.5;
  const lastPos = { L: { x: 0.3, y: 0.5 }, R: { x: 0.7, y: 0.5 } };
  let id = 0;

  // leadIn 以降の最初のグリッド拍から開始
  const firstK = Math.ceil((leadIn - offset) / beat);
  const stepK = Math.max(1, Math.round(conf.gapBeats));

  for (let k = firstK; ; k += stepK) {
    const tStart = offset + k * beat;
    const tEnd = tStart + conf.lenBeats * beat;
    if (tEnd > duration - tailOut) break;

    handFlip = !handFlip;
    const hand = handFlip ? 'R' : 'L';
    const xMin = hand === 'L' ? 0.1 : 0.52;
    const xMax = hand === 'L' ? 0.48 : 0.9;
    const yMin = 0.2, yMax = 0.75;

    // 前回の終点近くから始め、一定以上の長さの弧を描く。
    // 領域端でクランプされて経路が潰れないよう、候補から最も伸びる方向を選ぶ
    const step = (from, baseAngle) => {
      let best = null;
      let bestD = -1;
      for (let i = 0; i < 4; i++) {
        const ang = baseAngle === null
          ? rand() * Math.PI * 2
          : baseAngle + (rand() * 2 - 1) * (Math.PI / 3); // 進行方向±60°(滑らかな筆致)
        const len = 0.16 + rand() * 0.14;
        const cand = {
          x: clamp(from.x + Math.cos(ang) * len, xMin, xMax),
          y: clamp(from.y + Math.sin(ang) * len, yMin, yMax),
        };
        const d = Math.hypot(cand.x - from.x, cand.y - from.y);
        if (d > bestD) { bestD = d; best = cand; }
      }
      return best;
    };
    const prev = lastPos[hand];
    const p0 = {
      x: clamp(prev.x + (rand() * 2 - 1) * 0.15, xMin, xMax),
      y: clamp(prev.y + (rand() * 2 - 1) * 0.15, yMin, yMax),
    };
    const p1 = step(p0, null);
    const p2 = step(p1, Math.atan2(p1.y - p0.y, p1.x - p0.x));
    lastPos[hand] = p2;

    strokes.push({ id: id++, tStart, tEnd, hand, points: [p0, p1, p2] });
  }
  return strokes;
}

/** 経路の全長(正規化座標)。短すぎるストロークの検査などに使う */
export function strokeLength(points, n = 20) {
  const samples = sampleStroke(points, n);
  let len = 0;
  for (let i = 1; i < samples.length; i++) {
    len += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  }
  return len;
}
