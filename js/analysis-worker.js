// kagemai — ビート解析ワーカー
// メインスレッドをブロックせずに core/analysis.js の純粋関数を実行する。

import { analyzeBuffer } from './core/analysis.js';

self.onmessage = (e) => {
  const { channels, sampleRate } = e.data;
  try {
    const data = channels.map((ab) => new Float32Array(ab));
    const result = analyzeBuffer(data, sampleRate, {
      onProgress: (ratio, label) => self.postMessage({ type: 'progress', ratio, label }),
    });
    self.postMessage({
      type: 'result',
      result: {
        bpm: result.bpm,
        offset: result.offset,
        duration: result.duration,
        confidence: result.confidence,
        score: result.score,
        quantized: result.quantized,
        onsetCount: result.onsets.length,
      },
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
