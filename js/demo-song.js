// kagemai — 内蔵デモ曲(Tone.js のオフラインレンダリングで和風エレクトロニカを生成)
// 生成結果は通常の AudioBuffer なので、mp3 と同じ再生経路に乗る。

import { mulberry32 } from './core/chart.js';

export const DEMO_BPM = 96;

const TONE_CDN = 'https://cdn.jsdelivr.net/npm/tone@14.8.49/build/Tone.js';
let tonePromise = null;

export function loadTone() {
  if (window.Tone) return Promise.resolve(window.Tone);
  if (!tonePromise) {
    tonePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TONE_CDN;
      s.onload = () => resolve(window.Tone);
      s.onerror = () => {
        tonePromise = null;
        reject(new Error('Tone.js の読み込みに失敗しました。ネットワーク接続を確認してください。'));
      };
      document.head.appendChild(s);
    });
  }
  return tonePromise;
}

/**
 * デモ曲をオフラインレンダリングして AudioBuffer を返す。
 * short=true で短縮版(動作確認・E2E用)。
 */
export async function renderDemoSong({ short = false } = {}) {
  const Tone = await loadTone();
  const beat = 60 / DEMO_BPM;
  const bars = short ? 6 : 24;
  const total = bars * 4 * beat;
  const duration = total + 1.2; // 余韻

  // 陰音階(D 陰旋法): D, Eb, G, A, C
  const SCALE = ['D4', 'Eb4', 'G4', 'A4', 'C5', 'D5', 'G5'];
  const BASS = ['D2', 'D2', 'C2', 'A1'];
  const rand = mulberry32(20260708);

  const rendered = await Tone.Offline(() => {
    const taiko = new Tone.MembraneSynth({
      pitchDecay: 0.06, octaves: 5,
      envelope: { attack: 0.001, decay: 0.5, sustain: 0 },
      volume: -4,
    }).toDestination();

    const koto = new Tone.PluckSynth({
      attackNoise: 0.6, dampening: 3600, resonance: 0.96, volume: -4,
    });
    const kotoEcho = new Tone.FeedbackDelay({ delayTime: beat * 0.75, feedback: 0.22, wet: 0.25 });
    koto.chain(kotoEcho, Tone.getDestination());

    const bass = new Tone.FMSynth({
      harmonicity: 0.5, modulationIndex: 4,
      envelope: { attack: 0.005, decay: 0.3, sustain: 0.3, release: 0.2 },
      volume: -11,
    }).toDestination();

    const hat = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.035, sustain: 0 },
      volume: -22,
    }).toDestination();

    const bell = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.6, release: 0.1 },
      harmonicity: 8.5, resonance: 3000, octaves: 1.2,
      volume: -20,
    }).toDestination();

    for (let bar = 0; bar < bars; bar++) {
      const t0 = bar * 4 * beat;
      const section = short ? 1 : Math.floor(bar / 8); // 0:序 1:破 2:急

      // 太鼓: 1・3拍(破以降は「ドドン」を追加)
      taiko.triggerAttackRelease('D1', 0.3, t0);
      taiko.triggerAttackRelease('D1', 0.3, t0 + 2 * beat);
      if (section >= 1 && bar % 2 === 1) {
        taiko.triggerAttackRelease('G1', 0.2, t0 + 3.5 * beat);
      }

      // ハット: 裏拍
      if (section >= 1) {
        for (let b = 0; b < 4; b++) {
          hat.triggerAttackRelease(0.03, t0 + (b + 0.5) * beat);
        }
      }

      // ベース: 各拍
      const bn = BASS[bar % BASS.length];
      bass.triggerAttackRelease(bn, beat * 0.9, t0);
      if (section >= 1) bass.triggerAttackRelease(bn, beat * 0.4, t0 + 2.5 * beat);

      // 琴: 八分のランダムウォーク(序盤は疎)
      const densityP = section === 0 ? 0.3 : section === 1 ? 0.55 : 0.7;
      let idx = Math.floor(rand() * SCALE.length);
      for (let e = 0; e < 8; e++) {
        if (rand() > densityP) continue;
        idx = Math.max(0, Math.min(SCALE.length - 1, idx + Math.floor(rand() * 5) - 2));
        koto.triggerAttack(SCALE[idx], t0 + e * (beat / 2)); // PluckSynth は自己減衰

      }

      // 鈴: 各段落の頭
      if (bar % 4 === 0) bell.triggerAttackRelease('C6', 0.5, t0 + (short ? 0 : 2 * beat));
    }
  }, duration);

  // ToneAudioBuffer → ネイティブ AudioBuffer
  const buffer = rendered.get ? rendered.get() : rendered;
  return {
    name: short ? '影舞のテーマ(短縮版)' : '影舞のテーマ(内蔵デモ曲)',
    buffer,
    bpm: DEMO_BPM,
    offset: 0,
    duration: total,
  };
}
