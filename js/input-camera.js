// kagemai — カメラ入力(getUserMedia + MediaPipe Tasks Vision / Hand Landmarker)
// 手首〜人差し指の位置から「両手相当のポインタ2つ」を毎フレーム算出する。
// このモジュールはカメラモード選択時のみ動的 import される。

const VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const VEL_SMOOTH = 0.5;    // 速度の平滑化係数
const LOST_TIMEOUT = 350;  // 手を見失ってからポインタを消すまで (ms)
const LOOKAHEAD = 0.08;    // 先読み秒数(検出遅延を速度外挿で補う)

function mapGetUserMediaError(e) {
  switch (e && e.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'カメラの使用が拒否されました。ブラウザのサイト設定でカメラを許可してください。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'カメラが見つかりませんでした。';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'カメラを起動できませんでした。他のアプリがカメラを使用中の可能性があります。';
    case 'OverconstrainedError':
      return '要求した解像度にカメラが対応していません。';
    case 'SecurityError':
      return 'セキュリティ制限によりカメラを使用できません(HTTPSが必要です)。';
    default:
      return `カメラ初期化エラー(${(e && e.name) || '不明'})`;
  }
}

class CameraError extends Error {
  constructor(code, userMessage) {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
  }
}

export class CameraSource {
  constructor() {
    this.pointers = new Map(); // 'L' | 'R' -> pointer
    this.handsVisible = 0;
    this.video = null;
    this.stream = null;
    this.landmarker = null;
    this._lastVideoTime = -1;
    this._lastSeen = { L: 0, R: 0 };
  }

  async start({ videoEl, onStatus = () => {} }) {
    this.video = videoEl;

    if (!window.isSecureContext) {
      throw new CameraError('insecure',
        'HTTPS(または localhost)でないためカメラを使用できません。https:// でアクセスしてください。');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('unsupported', 'このブラウザはカメラ入力(getUserMedia)に対応していません。');
    }

    onStatus('camera-request');
    try {
      // スマホ負荷対策: 検出解像度は 640x480 に抑える
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
    } catch (e) {
      throw new CameraError(e && e.name, mapGetUserMediaError(e));
    }

    videoEl.srcObject = this.stream;
    videoEl.hidden = false;
    try { await videoEl.play(); } catch { /* autoplay 済みの場合など */ }

    onStatus('model-loading');
    try {
      const vision = await import(`${VISION_CDN}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        numHands: 2,
        runningMode: 'VIDEO',
      });
      try {
        this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, options('GPU'));
      } catch {
        this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, options('CPU'));
      }
    } catch (e) {
      this.stop();
      throw new CameraError('model',
        '手検出モデル(MediaPipe)の読み込みに失敗しました。ネットワーク接続を確認してください。');
    }
    onStatus('ready');
  }

  /** 毎フレーム呼ばれる。新しい映像フレームがある時だけ検出を実行する。 */
  update(nowMs) {
    const v = this.video;
    if (!this.landmarker || !v || v.readyState < 2) return;

    // ポインタの寿命管理
    for (const key of ['L', 'R']) {
      if (this.pointers.has(key) && nowMs - this._lastSeen[key] > LOST_TIMEOUT) {
        this.pointers.delete(key);
      }
    }

    if (v.currentTime === this._lastVideoTime) return; // 新フレームなし(カメラfpsに同期)
    this._lastVideoTime = v.currentTime;

    let result;
    try {
      result = this.landmarker.detectForVideo(v, nowMs);
    } catch {
      return;
    }
    const landmarks = result.landmarks || [];
    const handedness = result.handednesses || result.handedness || [];
    this.handsVisible = landmarks.length;

    // カメラ映像は cover 表示+鏡像。ランドマーク座標を画面正規化座標へ変換する。
    const vw = v.videoWidth, vh = v.videoHeight;
    const sw = window.innerWidth, sh = window.innerHeight;
    if (!vw || !vh) return;
    const scale = Math.max(sw / vw, sh / vh);
    const dw = vw * scale, dh = vh * scale;
    const ox = (dw - sw) / 2, oy = (dh - sh) / 2;
    const aspect = sw / sh;

    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      const wrist = lm[0];
      const indexTip = lm[8];
      // 手首→人差し指先端の 70% 地点を「手の位置」とする
      const rx = wrist.x + (indexTip.x - wrist.x) * 0.7;
      const ry = wrist.y + (indexTip.y - wrist.y) * 0.7;
      const mx = 1 - rx; // 鏡像
      const x = (mx * dw - ox) / sw;
      const y = (ry * dh - oy) / sh;

      // 鏡像表示のため MediaPipe の 'Left' は画面上の右手に相当
      const cat = handedness[i] && handedness[i][0] && handedness[i][0].categoryName;
      const key = cat === 'Left' ? 'R' : cat === 'Right' ? 'L' : (x < 0.5 ? 'L' : 'R');

      let p = this.pointers.get(key);
      if (!p) {
        p = { id: `cam${key}`, hand: key, x, y, vx: 0, vy: 0, active: true, _t: nowMs, _sx: x, _sy: y };
        this.pointers.set(key, p);
      } else {
        const dt = (nowMs - p._t) / 1000;
        if (dt > 0.001) {
          // 適応スムージング: 速い動きほど追従を優先して遅れを減らし、
          // 静止時は強めに平滑化して手ブレを消す(One Euro フィルタの簡易版)
          const speed = Math.hypot(p.vx, p.vy);
          const alpha = Math.min(0.85, 0.35 + speed * 0.25);
          const nsx = p._sx + (x - p._sx) * alpha;
          const nsy = p._sy + (y - p._sy) * alpha;
          const nvx = ((nsx - p._sx) * aspect) / dt;
          const nvy = (nsy - p._sy) / dt;
          p.vx += (nvx - p.vx) * VEL_SMOOTH;
          p.vy += (nvy - p.vy) * VEL_SMOOTH;
          p._sx = nsx;
          p._sy = nsy;
          p._t = nowMs;
        }
        // カメラ+検出の遅延ぶんを速度で外挿した位置を公開する
        p.x = p._sx + (p.vx / aspect) * LOOKAHEAD;
        p.y = p._sy + p.vy * LOOKAHEAD;
      }
      this._lastSeen[key] = nowMs;
    }
  }

  stop() {
    if (this.landmarker) {
      try { this.landmarker.close(); } catch { /* noop */ }
      this.landmarker = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
    this.pointers.clear();
    this.handsVisible = 0;
  }
}
