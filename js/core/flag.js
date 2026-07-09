// kagemai — 旗印モード(旗上げ式)コア(純粋関数のみ)
// 「矢印の方へ手を振る」出題列を生成する。判定は core/judge.js の
// checkSwipe(方向±60°・速度しきい値)と judgeTiming(寛容な窓)を流用する。

import { mulberry32 } from './chart.js';

// 画面座標系(y は下向き)。「上げて」= y 負方向へ動かす
export const FLAG_DIRS = Object.freeze({
  up: { x: 0, y: -1, label: '上' },
  down: { x: 0, y: 1, label: '下' },
  left: { x: -1, y: 0, label: '左' },
  right: { x: 1, y: 0, label: '右' },
});

export const FLAG_DENSITY = Object.freeze({
  low: { gapBeats: 4 },
  normal: { gapBeats: 2 },
  high: { gapBeats: 1 },
});

// 旗上げらしい寛容な判定窓(±秒)。方向が合っていればよい
export const FLAG_WINDOWS = Object.freeze({ perfect: 0.2, good: 0.45 });

/**
 * 出題列を生成する。
 * コマンド: {id, time, hand:'L'|'R'|'B'(両手), dir:'up'|'down'|'left'|'right'}
 * - 基本は左右交互、時々同じ手を続けて出す(ひっかけ)
 * - allowBoth=true なら約8回に1回、両手同時(B)を出す
 */
export function generateFlagChart({
  duration,
  bpm,
  offset = 0,
  density = 'normal',
  seed = 7,
  leadIn = 2.0,
  tailOut = 1.0,
  allowBoth = true,
}) {
  if (!(bpm > 0) || !(duration > 0)) return [];
  const beat = 60 / bpm;
  const gap = (FLAG_DENSITY[density] || FLAG_DENSITY.normal).gapBeats;
  const rand = mulberry32(seed);
  const dirNames = Object.keys(FLAG_DIRS);

  const out = [];
  let id = 0;
  let lastHand = rand() < 0.5 ? 'L' : 'R';
  const firstK = Math.ceil((leadIn - offset) / beat);

  for (let k = firstK; ; k += gap) {
    const time = offset + k * beat;
    if (time > duration - tailOut) break;
    const r = rand();
    let hand;
    if (allowBoth && out.length >= 3 && (id % 8 === 7 || r < 0.08)) {
      hand = 'B';
    } else if (r < 0.65) {
      hand = lastHand === 'L' ? 'R' : 'L'; // 基本は交互
    } else {
      hand = lastHand; // ひっかけ: 同じ手をもう一度
    }
    if (hand !== 'B') lastHand = hand;
    const dir = dirNames[Math.floor(rand() * dirNames.length)];
    out.push({ id: id++, time, hand, dir });
  }
  return out;
}
