import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateStrokeChart, sampleStroke, strokeGrade, strokeLength, beatIndex, STROKE_DENSITY,
} from '../js/core/stroke.js';

const BASE = { duration: 60, bpm: 120, offset: 0.5, seed: 42 };

test('strokeGrade: カバー率の境界値', () => {
  assert.equal(strokeGrade(1.0), 'perfect');
  assert.equal(strokeGrade(0.8), 'perfect');   // 境界は上のランク
  assert.equal(strokeGrade(0.799), 'good');
  assert.equal(strokeGrade(0.4), 'good');
  assert.equal(strokeGrade(0.399), 'miss');
  assert.equal(strokeGrade(0), 'miss');
});

test('beatIndex: グリッド基準の拍番号', () => {
  assert.equal(beatIndex(0.5, 120, 0.5), 0);
  assert.equal(beatIndex(0.99, 120, 0.5), 0);
  assert.equal(beatIndex(1.0, 120, 0.5), 1);
  assert.equal(beatIndex(2.5, 120, 0.5), 4);
});

test('sampleStroke: 端点が制御点に一致し、進行度が単調', () => {
  const points = [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.6 }, { x: 0.8, y: 0.3 }];
  const s = sampleStroke(points, 20);
  assert.equal(s.length, 20);
  assert.ok(Math.abs(s[0].x - 0.2) < 1e-9 && Math.abs(s[0].y - 0.3) < 1e-9);
  assert.ok(Math.abs(s[19].x - 0.8) < 1e-9 && Math.abs(s[19].y - 0.3) < 1e-9);
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i].u > s[i - 1].u);
    // 隣接サンプルが離れすぎない(描画・判定の連続性)
    const d = Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
    assert.ok(d < 0.1, `gap=${d}`);
  }
});

test('generateStrokeChart: 決定的で時刻順・範囲内・ビート同期', () => {
  const a = generateStrokeChart({ ...BASE });
  const b = generateStrokeChart({ ...BASE });
  assert.deepEqual(a, b); // 同じシードなら同じ譜面
  assert.ok(a.length > 10, `strokes=${a.length}`);
  const beat = 60 / BASE.bpm;
  for (let i = 0; i < a.length; i++) {
    const s = a[i];
    assert.ok(s.tStart >= 2.0 && s.tEnd <= BASE.duration - 1.5);
    assert.ok(s.tEnd > s.tStart);
    if (i > 0) assert.ok(s.tStart > a[i - 1].tStart);
    // グリッド拍に同期している
    const pos = (s.tStart - BASE.offset) / beat;
    assert.ok(Math.abs(pos - Math.round(pos)) < 1e-6, `off-grid: ${s.tStart}`);
    // 制御点が手の可動域内
    for (const p of s.points) {
      assert.ok(p.y >= 0.2 && p.y <= 0.75);
      if (s.hand === 'L') assert.ok(p.x >= 0.1 && p.x <= 0.48);
      else assert.ok(p.x >= 0.52 && p.x <= 0.9);
    }
    // なぞれる長さがある
    assert.ok(strokeLength(s.points) >= 0.1, `too short: ${strokeLength(s.points)}`);
  }
});

test('generateStrokeChart: 同じ手のストロークは重ならない', () => {
  for (const density of ['low', 'normal', 'high']) {
    const strokes = generateStrokeChart({ ...BASE, density });
    const last = { L: -Infinity, R: -Infinity };
    for (const s of strokes) {
      assert.ok(s.tStart >= last[s.hand], `${density}: 同じ手が重複`);
      last[s.hand] = s.tEnd;
    }
  }
});

test('generateStrokeChart: 密度の大小関係', () => {
  const low = generateStrokeChart({ ...BASE, density: 'low' });
  const normal = generateStrokeChart({ ...BASE, density: 'normal' });
  const high = generateStrokeChart({ ...BASE, density: 'high' });
  assert.ok(low.length < normal.length);
  assert.ok(normal.length <= high.length);
});

test('generateStrokeChart: 不正入力は空配列', () => {
  assert.deepEqual(generateStrokeChart({ duration: 0, bpm: 120 }), []);
  assert.deepEqual(generateStrokeChart({ duration: 60, bpm: 0 }), []);
});
