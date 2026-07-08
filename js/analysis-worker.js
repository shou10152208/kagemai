// kagemai — ビート解析ワーカー
// メインスレッドをブロックせずに core/analysis.js の純粋関数を実行する。

import { analyzeBuffer, computeEnergyTimeline, detectHighlights } from './core/analysis.js';

self.onmessage = (e) => {
  const { channels, sampleRate, energyOnly } = e.data;
  try {
    const data = channels.map((ab) => new Float32Array(ab));

    // 演出用: エネルギータイムラインと高揚区間(サビ)検出
    const { energy, rate: energyRate } = computeEnergyTimeline(data, sampleRate);
    const highlights = detectHighlights(energy, energyRate);

    if (energyOnly) {
      // デモ曲など、BPM既知でビート解析が不要な場合
      self.postMessage(
        { type: 'result', result: { energy: energy.buffer, energyRate, highlights } },
        [energy.buffer],
      );
      return;
    }

    const result = analyzeBuffer(data, sampleRate, {
      onProgress: (ratio, label) => self.postMessage({ type: 'progress', ratio, label }),
    });
    self.postMessage(
      {
        type: 'result',
        result: {
          bpm: result.bpm,
          offset: result.offset,
          duration: result.duration,
          confidence: result.confidence,
          score: result.score,
          quantized: result.quantized,
          onsetCount: result.onsets.length,
          energy: energy.buffer,
          energyRate,
          highlights,
        },
      },
      [energy.buffer],
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
