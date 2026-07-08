import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateChart, beatsFromBpm, mulberry32, DENSITY } from '../js/core/chart.js';

const BASE = { duration: 60, bpm: 120, offset: 0.5, seed: 42 };

test('mulberry32: 決定的で [0,1) を返す', () => {
  const r1 = mulberry32(123);
  const r2 = mulberry32(123);
  for (let i = 0; i < 100; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});

test('generateChart: 時刻順・範囲内・位置が可動域内', () => {
  const notes = generateChart({ ...BASE, density: 'normal' });
  assert.ok(notes.length > 20, `notes=${notes.length}`);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    assert.ok(n.time >= 1.8 && n.time <= BASE.duration - 1.0);
    assert.ok(n.x >= 0.12 && n.x <= 0.88);
    assert.ok(n.y >= 0.22 && n.y <= 0.72);
    assert.ok(n.hand === 'L' || n.hand === 'R');
    if (i > 0) assert.ok(n.time > notes[i - 1].time);
    // 手と可動域の対応
    if (n.hand === 'L') assert.ok(n.x <= 0.48);
    else assert.ok(n.x >= 0.52);
  }
});

test('generateChart: 密度の大小関係と最小間隔', () => {
  const low = generateChart({ ...BASE, density: 'low' });
  const normal = generateChart({ ...BASE, density: 'normal' });
  const high = generateChart({ ...BASE, density: 'high' });
  assert.ok(low.length < normal.length, `low=${low.length} normal=${normal.length}`);
  assert.ok(normal.length < high.length, `normal=${normal.length} high=${high.length}`);
  const beat = 60 / BASE.bpm;
  for (const [notes, conf] of [[low, DENSITY.low], [normal, DENSITY.normal], [high, DENSITY.high]]) {
    for (let i = 1; i < notes.length; i++) {
      assert.ok(notes[i].time - notes[i - 1].time >= beat * conf.gapBeats * 0.98 - 1e-9);
    }
  }
});

test('generateChart: hard はスワイプノーツを含み dir が単位ベクトル', () => {
  const notes = generateChart({ ...BASE, density: 'high', difficulty: 'hard' });
  const swipes = notes.filter((n) => n.type === 'swipe');
  assert.ok(swipes.length > 0);
  for (const s of swipes) {
    const len = Math.hypot(s.dir.x, s.dir.y);
    assert.ok(Math.abs(len - 1) < 0.01);
  }
  const normal = generateChart({ ...BASE, difficulty: 'normal' });
  assert.ok(normal.every((n) => n.type === 'tap'));
});

test('generateChart: オンセット指定時はオンセット時刻の部分集合', () => {
  const onsets = beatsFromBpm(100, 0.3, 40);
  const notes = generateChart({ duration: 40, bpm: 100, offset: 0.3, onsets, density: 'normal', seed: 1 });
  assert.ok(notes.length > 10);
  const times = new Set(onsets.map((o) => o.time));
  for (const n of notes) assert.ok(times.has(n.time));
});

test('generateChart: 不正入力は空配列', () => {
  assert.deepEqual(generateChart({ duration: 0, bpm: 120 }), []);
  assert.deepEqual(generateChart({ duration: 60, bpm: 0 }), []);
});

test('beatsFromBpm: 等間隔・ダウンビート強調', () => {
  const beats = beatsFromBpm(120, 0, 4);
  assert.equal(beats.length, 8);
  assert.equal(beats[0].strength, 1);
  assert.equal(beats[1].strength, 0.6);
  assert.equal(beats[4].strength, 1);
});
