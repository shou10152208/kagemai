import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JUDGE, judgeTiming, isNoteExpired, isPointerOnNote, checkSwipe,
  judgeNoteHit, scoreForJudge, maxPossibleScore, rankForRatio,
} from '../js/core/judge.js';

const W = { perfect: 0.05, good: 0.15 };

test('judgeTiming: 境界値', () => {
  assert.equal(judgeTiming(0, W), JUDGE.PERFECT);
  assert.equal(judgeTiming(0.05, W), JUDGE.PERFECT);   // 境界は含む
  assert.equal(judgeTiming(-0.05, W), JUDGE.PERFECT);
  assert.equal(judgeTiming(0.0501, W), JUDGE.GOOD);
  assert.equal(judgeTiming(0.15, W), JUDGE.GOOD);      // 境界は含む
  assert.equal(judgeTiming(-0.15, W), JUDGE.GOOD);
  assert.equal(judgeTiming(0.1501, W), null);          // 窓外
  assert.equal(judgeTiming(-0.2, W), null);
});

test('isNoteExpired: good窓を過ぎたらMiss確定', () => {
  assert.equal(isNoteExpired(10, 10.15, W), false);
  assert.equal(isNoteExpired(10, 10.1501, W), true);
  assert.equal(isNoteExpired(10, 9.0, W), false); // まだ来ていない
});

test('isPointerOnNote: 半径境界とアスペクト補正', () => {
  assert.equal(isPointerOnNote(0.5, 0.5, 0.5, 0.5, 0.09), true);
  assert.equal(isPointerOnNote(0.5, 0.59, 0.5, 0.5, 0.09), true);   // 境界ちょうど
  assert.equal(isPointerOnNote(0.5, 0.591, 0.5, 0.5, 0.09), false);
  // アスペクト2倍なら横方向距離は2倍換算
  assert.equal(isPointerOnNote(0.55, 0.5, 0.5, 0.5, 0.09, 2), false); // dx=0.1*... -> 0.1
  assert.equal(isPointerOnNote(0.54, 0.5, 0.5, 0.5, 0.09, 2), true);  // 0.08 <= 0.09
});

test('checkSwipe: 速度と方向', () => {
  const right = { x: 1, y: 0 };
  assert.equal(checkSwipe(1.5, 0, right, 1.0), true);
  assert.equal(checkSwipe(0.5, 0, right, 1.0), false);         // 遅すぎ
  assert.equal(checkSwipe(-1.5, 0, right, 1.0), false);        // 逆方向
  assert.equal(checkSwipe(1.2, 1.2, right, 1.0), true);        // 45°はOK(±60°許容)
  assert.equal(checkSwipe(0.1, 2.0, right, 1.0), false);       // ほぼ真上はNG
});

test('judgeNoteHit: 総合判定', () => {
  const note = { time: 10, x: 0.5, y: 0.5, type: 'tap' };
  const p = { x: 0.5, y: 0.5, vx: 0, vy: 0, active: true };
  assert.deepEqual(judgeNoteHit(note, p, 10.02, { windows: W }), { judge: JUDGE.PERFECT, dt: 10.02 - 10 });
  assert.equal(judgeNoteHit(note, p, 10.1, { windows: W }).judge, JUDGE.GOOD);
  assert.equal(judgeNoteHit(note, p, 10.2, { windows: W }), null);
  assert.equal(judgeNoteHit(note, { ...p, active: false }, 10, { windows: W }), null);
  assert.equal(judgeNoteHit(note, { ...p, x: 0.9 }, 10, { windows: W }), null);

  const swipe = { time: 10, x: 0.5, y: 0.5, type: 'swipe', dir: { x: 1, y: 0 } };
  assert.equal(judgeNoteHit(swipe, p, 10, { windows: W }), null); // 静止では取れない
  assert.equal(judgeNoteHit(swipe, { ...p, vx: 2 }, 10, { windows: W }).judge, JUDGE.PERFECT);
});

test('スコアとランク', () => {
  assert.equal(scoreForJudge(JUDGE.PERFECT, 0), 100);
  assert.equal(scoreForJudge(JUDGE.PERFECT, 50), 150);
  assert.equal(scoreForJudge(JUDGE.PERFECT, 200), 200); // 上限+100%
  assert.equal(scoreForJudge(JUDGE.GOOD, 0), 60);
  assert.equal(scoreForJudge(JUDGE.MISS, 10), 0);
  assert.equal(maxPossibleScore(2), 100 + 101);
  assert.equal(rankForRatio(0.96), '極');
  assert.equal(rankForRatio(0.85), '雅');
  assert.equal(rankForRatio(0.7), '彩');
  assert.equal(rankForRatio(0.5), '踏');
  assert.equal(rankForRatio(0.1), '芽');
});
