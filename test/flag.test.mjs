import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFlagChart, FLAG_DIRS, FLAG_DENSITY, FLAG_WINDOWS } from '../js/core/flag.js';
import { checkSwipe, judgeTiming } from '../js/core/judge.js';

const BASE = { duration: 60, bpm: 120, offset: 0.5, seed: 42 };

test('generateFlagChart: 決定的・時刻順・ビート同期・有効な値', () => {
  const a = generateFlagChart({ ...BASE });
  const b = generateFlagChart({ ...BASE });
  assert.deepEqual(a, b);
  assert.ok(a.length > 10);
  const beat = 60 / BASE.bpm;
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    assert.ok(c.time >= 2.0 && c.time <= BASE.duration - 1.0);
    if (i > 0) assert.ok(c.time > a[i - 1].time);
    const pos = (c.time - BASE.offset) / beat;
    assert.ok(Math.abs(pos - Math.round(pos)) < 1e-6);
    assert.ok(['L', 'R', 'B'].includes(c.hand));
    assert.ok(c.dir in FLAG_DIRS);
  }
});

test('generateFlagChart: 両手(B)と左右の両方が出題される', () => {
  const cmds = generateFlagChart({ ...BASE, duration: 120 });
  const hands = new Set(cmds.map((c) => c.hand));
  assert.ok(hands.has('L') && hands.has('R') && hands.has('B'));
});

test('generateFlagChart: allowBoth=false では両手が出ない(マウス用)', () => {
  const cmds = generateFlagChart({ ...BASE, duration: 120, allowBoth: false });
  assert.ok(cmds.length > 20);
  assert.ok(cmds.every((c) => c.hand !== 'B'));
});

test('generateFlagChart: 密度の大小関係', () => {
  const low = generateFlagChart({ ...BASE, density: 'low' });
  const normal = generateFlagChart({ ...BASE, density: 'normal' });
  const high = generateFlagChart({ ...BASE, density: 'high' });
  assert.ok(low.length < normal.length && normal.length < high.length);
  assert.equal(FLAG_DENSITY.low.gapBeats, 4);
});

test('旗印の判定部品: 方向一致と寛容な窓(既存純粋関数の流用)', () => {
  // 「上げて」(画面上方向) = vy 負
  assert.equal(checkSwipe(0, -1.5, FLAG_DIRS.up, 1.0), true);
  assert.equal(checkSwipe(0, 1.5, FLAG_DIRS.up, 1.0), false);
  assert.equal(checkSwipe(1.5, 0, FLAG_DIRS.right, 1.0), true);
  // 窓: ±0.2s 極 / ±0.45s 良
  assert.equal(judgeTiming(0.1, FLAG_WINDOWS), 'perfect');
  assert.equal(judgeTiming(-0.2, FLAG_WINDOWS), 'perfect');
  assert.equal(judgeTiming(0.3, FLAG_WINDOWS), 'good');
  assert.equal(judgeTiming(0.46, FLAG_WINDOWS), null);
});

test('generateFlagChart: 不正入力は空配列', () => {
  assert.deepEqual(generateFlagChart({ duration: 0, bpm: 120 }), []);
  assert.deepEqual(generateFlagChart({ duration: 60, bpm: 0 }), []);
});
