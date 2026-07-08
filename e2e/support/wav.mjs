// テスト用 WAV ファイル生成(16bit PCM モノラル)
// 既知の BPM のクリックトラックを作り、解析パイプラインを E2E で検証する。

export function makeClickTrackWav({ sampleRate = 22050, duration = 20, bpm = 120, offset = 0.25 } = {}) {
  const n = Math.floor(sampleRate * duration);
  const samples = new Float32Array(n);
  const beat = 60 / bpm;
  for (let t = offset; t < duration - 0.2; t += beat) {
    const start = Math.floor(t * sampleRate);
    for (let i = 0; i < Math.floor(0.05 * sampleRate); i++) {
      const tt = i / sampleRate;
      const v = Math.sin(2 * Math.PI * 100 * tt) * Math.exp(-tt * 60);
      if (start + i < n) samples[start + i] += v * 0.8;
    }
  }

  const bytesPerSample = 2;
  const dataSize = n * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);            // fmt チャンクサイズ
  buf.writeUInt16LE(1, 20);             // PCM
  buf.writeUInt16LE(1, 22);             // モノラル
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);            // ビット深度
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}
