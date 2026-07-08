// kagemai — 判定コア(純粋関数のみ)
// Z座標は使わない。時刻差と2D位置の重なりだけで判定する。

export const JUDGE = Object.freeze({
  PERFECT: 'perfect',
  GOOD: 'good',
  MISS: 'miss',
});

export const DEFAULT_WINDOWS = Object.freeze({ perfect: 0.05, good: 0.15 });

/**
 * 時刻差 dt(秒、hitTime - noteTime)から判定を返す。
 * 窓の境界値は含む(|dt| <= window)。窓外は null(未判定)。
 */
export function judgeTiming(dt, windows = DEFAULT_WINDOWS) {
  const a = Math.abs(dt);
  if (a <= windows.perfect) return JUDGE.PERFECT;
  if (a <= windows.good) return JUDGE.GOOD;
  return null;
}

/** ノーツの判定時刻を過ぎて窓を出たか(= Miss 確定か) */
export function isNoteExpired(noteTime, now, windows = DEFAULT_WINDOWS) {
  return now - noteTime > windows.good + 1e-9; // 浮動小数点の境界誤差を吸収
}

/**
 * ポインタがノーツに重なっているか。
 * 座標は正規化(x: 0..1 横, y: 0..1 縦)。aspect = 画面幅/高さ。
 * radius は高さ基準の正規化半径。境界値は「重なり」とみなす。
 */
export function isPointerOnNote(px, py, nx, ny, radius, aspect = 1) {
  const dx = (px - nx) * aspect;
  const dy = py - ny;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * スワイプ条件: 速度ベクトル (vx, vy) が指定方向 dir({x,y} 単位ベクトル)へ
 * minSpeed 以上で動いているか。方向の許容角は ±60°。
 */
export function checkSwipe(vx, vy, dir, minSpeed = 1.0) {
  const speed = Math.hypot(vx, vy);
  if (speed < minSpeed) return false;
  const dot = (vx * dir.x + vy * dir.y) / speed;
  return dot >= 0.5; // cos(60°)
}

/**
 * 1ノーツ×1ポインタの総合判定。
 * note: {time, x, y, type:'tap'|'swipe', dir?}
 * pointer: {x, y, vx, vy, active}
 * 戻り値: {judge:'perfect'|'good', dt} または null(ヒットせず)
 */
export function judgeNoteHit(note, pointer, now, {
  windows = DEFAULT_WINDOWS,
  radius = 0.09,
  aspect = 1,
  minSwipeSpeed = 1.0,
} = {}) {
  if (!pointer.active) return null;
  const dt = now - note.time;
  const timing = judgeTiming(dt, windows);
  if (!timing) return null;
  if (!isPointerOnNote(pointer.x, pointer.y, note.x, note.y, radius, aspect)) return null;
  if (note.type === 'swipe' && !checkSwipe(pointer.vx, pointer.vy, note.dir, minSwipeSpeed)) return null;
  return { judge: timing, dt };
}

/** 判定ごとの基礎点 */
export const BASE_SCORE = Object.freeze({ perfect: 100, good: 60, miss: 0 });

/**
 * スコア加算値を計算する。コンボは加算「前」のコンボ数を渡す。
 * コンボボーナス: +1%/combo(上限 +100%)
 */
export function scoreForJudge(judge, combo) {
  const base = BASE_SCORE[judge] ?? 0;
  if (base === 0) return 0;
  const mult = 1 + Math.min(combo, 100) * 0.01;
  return Math.round(base * mult);
}

/** 理論上の最大スコア(全ノーツ Perfect) */
export function maxPossibleScore(noteCount) {
  let s = 0;
  for (let i = 0; i < noteCount; i++) s += scoreForJudge(JUDGE.PERFECT, i);
  return s;
}

/** 達成率(0..1)からランク文字を返す */
export function rankForRatio(ratio) {
  if (ratio >= 0.95) return '極';
  if (ratio >= 0.85) return '雅';
  if (ratio >= 0.7) return '彩';
  if (ratio >= 0.5) return '踏';
  return '芽';
}
