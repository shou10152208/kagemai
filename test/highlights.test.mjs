import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEnergyTimeline, detectHighlights } from '../js/core/analysis.js';

/** 静かな土台 + 指定区間だけ大きい合成波形 */
function synthDynamicTrack({ sampleRate = 11025, duration = 60, loud = [[20, 32]], base = 0.08, peak = 0.6 }) {
  const n = sampleRate * duration;
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let amp = base;
    for (const [s, e] of loud) {
      if (t >= s && t < e) amp = peak * (0.85 + 0.15 * Math.sin(t * 2)); // 区間内も揺らす
    }
    buf[i] = Math.sin(2 * Math.PI * 220 * t) * amp;
  }
  return buf;
}

test('computeEnergyTimeline: 正規化された時系列を返す', () => {
  const buf = synthDynamicTrack({ duration: 30 });
  const { energy, rate } = computeEnergyTimeline([buf], 11025);
  assert.ok(rate > 15 && rate < 25, `rate=${rate}`);
  assert.equal(energy.length, Math.floor(30 * rate));
  let max = 0;
  for (const v of energy) { assert.ok(v >= 0 && v <= 1); max = Math.max(max, v); }
  assert.ok(max > 0.9, `max=${max}`); // 95%点が1に正規化される
  // 静かな冒頭 < 盛り上がり区間
  const at = (sec) => energy[Math.floor(sec * rate)];
  assert.ok(at(5) < at(25), `quiet=${at(5)} loud=${at(25)}`);
});

test('detectHighlights: 盛り上がり区間を検出する', () => {
  const buf = synthDynamicTrack({ duration: 60, loud: [[20, 32]] });
  const { energy, rate } = computeEnergyTimeline([buf], 11025);
  const hl = detectHighlights(energy, rate);
  assert.equal(hl.length, 1, JSON.stringify(hl));
  const h = hl[0];
  assert.ok(Math.abs(h.start - 20) < 3, `start=${h.start}`);
  assert.ok(Math.abs(h.end - 32) < 3, `end=${h.end}`);
  assert.ok(h.peak >= h.start && h.peak <= h.end);
});

test('detectHighlights: 複数区間は時刻順・上限件数', () => {
  const buf = synthDynamicTrack({ duration: 120, loud: [[20, 30], [50, 62], [90, 100]] });
  const { energy, rate } = computeEnergyTimeline([buf], 11025);
  const hl = detectHighlights(energy, rate, { maxRegions: 2 });
  assert.equal(hl.length, 2);
  assert.ok(hl[0].start < hl[1].start);
});

test('detectHighlights: 平坦な曲では検出しない', () => {
  const buf = synthDynamicTrack({ duration: 60, loud: [], base: 0.3 });
  const { energy, rate } = computeEnergyTimeline([buf], 11025);
  assert.deepEqual(detectHighlights(energy, rate), []);
});

test('detectHighlights: 短すぎる曲では検出しない', () => {
  const buf = synthDynamicTrack({ duration: 8, loud: [[2, 6]] });
  const { energy, rate } = computeEnergyTimeline([buf], 11025);
  assert.deepEqual(detectHighlights(energy, rate), []);
});
