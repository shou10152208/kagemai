import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mixdown, decimate, lowpassFilter, energyEnvelope,
  detectOnsets, estimateBpm, fitBeatGrid, quantizeOnsets, analyzeBuffer,
} from '../js/core/analysis.js';

/** 低音クリック(100Hz減衰バースト)を指定時刻に置いた合成波形を作る */
function synthClickTrack({ sampleRate = 22050, duration = 20, bpm = 120, offset = 0.25, jitter = 0, seed = 1 }) {
  const n = Math.floor(sampleRate * duration);
  const buf = new Float32Array(n);
  const beat = 60 / bpm;
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const times = [];
  for (let t = offset; t < duration - 0.2; t += beat) {
    const jt = t + (rand() * 2 - 1) * jitter;
    times.push(jt);
    const start = Math.floor(jt * sampleRate);
    for (let i = 0; i < Math.floor(0.05 * sampleRate); i++) {
      const tt = i / sampleRate;
      const v = Math.sin(2 * Math.PI * 100 * tt) * Math.exp(-tt * 60);
      if (start + i < n) buf[start + i] += v * 0.8;
    }
  }
  return { buf, times };
}

test('mixdown / decimate の基本動作', () => {
  const a = new Float32Array([1, 1, 1, 1]);
  const b = new Float32Array([0, 0, 0, 0]);
  const m = mixdown([a, b]);
  assert.equal(m[0], 0.5);
  const d = decimate(new Float32Array([1, 3, 5, 7]), 2);
  assert.equal(d.length, 2);
  assert.equal(d[0], 2);
  assert.equal(d[1], 6);
});

test('lowpassFilter: 高周波を減衰させ低周波を通す', () => {
  const sr = 22050;
  const n = sr;
  const low = new Float32Array(n);
  const high = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    low[i] = Math.sin((2 * Math.PI * 50 * i) / sr);
    high[i] = Math.sin((2 * Math.PI * 2000 * i) / sr);
  }
  const rms = (x) => {
    let s = 0;
    for (let i = Math.floor(n / 2); i < n; i++) s += x[i] * x[i];
    return Math.sqrt(s / (n / 2));
  };
  const lf = lowpassFilter(low, sr, 150);
  const hf = lowpassFilter(high, sr, 150);
  assert.ok(rms(lf) > 0.6, `低域が通っていない: ${rms(lf)}`);
  assert.ok(rms(hf) < 0.05, `高域が減衰していない: ${rms(hf)}`);
});

test('detectOnsets: クリック位置を検出する', () => {
  const sr = 22050;
  const { buf, times } = synthClickTrack({ sampleRate: sr, duration: 10, bpm: 120 });
  const filtered = lowpassFilter(buf, sr, 150);
  const { env, hopTime } = energyEnvelope(filtered, sr, { frame: 512, hop: 128 });
  const onsets = detectOnsets(env, hopTime);
  // クリック数に近い数が出る(±30%)
  assert.ok(onsets.length >= times.length * 0.7 && onsets.length <= times.length * 1.3,
    `onsets=${onsets.length} clicks=${times.length}`);
  // 各オンセットが実クリックの近く(±60ms)にある
  let near = 0;
  for (const o of onsets) {
    if (times.some((t) => Math.abs(o.time - t) < 0.06)) near++;
  }
  assert.ok(near / onsets.length > 0.85, `近接率 ${near}/${onsets.length}`);
});

test('estimateBpm + analyzeBuffer: 120BPM を推定できる', () => {
  const { buf } = synthClickTrack({ sampleRate: 22050, duration: 20, bpm: 120, jitter: 0.008 });
  const result = analyzeBuffer([buf], 22050);
  assert.ok(Math.abs(result.bpm - 120) < 2, `bpm=${result.bpm}`);
  assert.ok(result.quantized.length > 8);
});

test('analyzeBuffer: 90BPM(オフセット付き)も推定できる', () => {
  const { buf } = synthClickTrack({ sampleRate: 22050, duration: 24, bpm: 90, offset: 0.6 });
  const result = analyzeBuffer([buf], 22050);
  assert.ok(Math.abs(result.bpm - 90) < 2, `bpm=${result.bpm}`);
  // グリッド位相が実ビート(offset=0.6)に合っている(ビート間隔の12%以内)
  const beat = 60 / result.bpm;
  let d = (0.6 - result.offset) % beat;
  if (d > beat / 2) d -= beat;
  if (d < -beat / 2) d += beat;
  assert.ok(Math.abs(d) < beat * 0.12, `phase error=${d} (beat=${beat})`);
});

test('analyzeBuffer: 無音は失敗として bpm=0 を返す', () => {
  const silent = new Float32Array(22050 * 5);
  const result = analyzeBuffer([silent], 22050);
  assert.equal(result.bpm, 0);
  assert.equal(result.quantized.length, 0);
});

test('fitBeatGrid: 位相を回復する', () => {
  const onsets = [];
  for (let i = 0; i < 20; i++) onsets.push({ time: 0.37 + i * 0.5, strength: 1 });
  const g = fitBeatGrid(onsets, 120);
  assert.ok(Math.abs(g.bpm - 120) < 0.5, `bpm=${g.bpm}`);
  let d = (0.37 - g.offset) % 0.5;
  if (d > 0.25) d -= 0.5;
  assert.ok(Math.abs(d) < 0.02, `offset=${g.offset}`);
  assert.ok(g.score > 0.9);
});

test('quantizeOnsets: グリッドに吸着し重複は強い方を残す', () => {
  const onsets = [
    { time: 1.01, strength: 0.5 },
    { time: 1.02, strength: 0.9 }, // 同一グリッド → 強い方
    { time: 1.52, strength: 0.7 },
  ];
  const q = quantizeOnsets(onsets, 120, 0, 2); // step=0.25
  assert.equal(q.length, 2);
  assert.equal(q[0].time, 1.0);
  assert.equal(q[0].strength, 0.9);
  assert.equal(q[1].time, 1.5);
});
