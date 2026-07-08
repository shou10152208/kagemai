// kagemai — 入力抽象化レイヤー
// ゲーム本体は「ポインタ(位置+速度ベクトル)の配列」と「レーンキーイベント」
// だけを受け取る。カメラ/タッチ/マウスの差はここで吸収する。
//
// ポインタ: {id, hand:'L'|'R', x, y, vx, vy, active}
//   x, y: 画面正規化座標(0..1)
//   vx, vy: 正規化速度(高さ基準/秒、x はアスペクト補正済み)
//   active: 判定に使ってよい状態か(マウスは押下中のみ true)

export const LANE_KEYS = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };
export const LANE_COUNT = 4;

export const MODE_LABELS = {
  camera: 'カメラ',
  touch: 'タッチ',
  mouse: 'マウス・キーボード',
};

/** 起動時の推奨入力モードを判定する */
export async function detectRecommendedMode() {
  const hasTouch = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  if (window.isSecureContext && navigator.mediaDevices?.getUserMedia) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (devices.some((d) => d.kind === 'videoinput')) return 'camera';
    } catch {
      // enumerateDevices 失敗時はカメラなし扱い
    }
  }
  return hasTouch ? 'touch' : 'mouse';
}

/** カメラが使えない理由(使えるなら null) */
export function cameraUnavailableReason() {
  if (!window.isSecureContext) {
    return 'HTTPS(または localhost)でないためカメラを使用できません。https でアクセスしてください。';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'このブラウザはカメラ入力(getUserMedia)に対応していません。';
  }
  return null;
}

const VEL_SMOOTH = 0.45;

export class InputManager {
  constructor() {
    this.mode = null;
    this.pointers = new Map();
    this.onLaneKey = null;   // (lane:number) => void
    this.camera = null;      // CameraSource(モード camera 時のみ)
    this._listeners = [];
    this._keyListener = null;
  }

  get aspect() {
    return window.innerWidth / Math.max(1, window.innerHeight);
  }

  /**
   * 入力モードを切り替える。camera の場合は opts.videoEl / onStatus が必要。
   * カメラ初期化失敗時は例外を投げる(呼び出し側でフォールバック)。
   */
  async setMode(mode, opts = {}) {
    this.teardown();
    if (mode === 'camera') {
      const { CameraSource } = await import('./input-camera.js');
      const cam = new CameraSource();
      await cam.start(opts);
      this.camera = cam;
    } else {
      this._attachPointerEvents();
      this._attachKeyEvents();
    }
    this.mode = mode;
  }

  _attachPointerEvents() {
    const down = (e) => {
      const p = this._entryFor(e);
      p.active = true;
      this._move(p, e);
    };
    const move = (e) => {
      const p = this._entryFor(e);
      if (e.pointerType === 'mouse') p.active = e.buttons > 0;
      this._move(p, e);
    };
    const up = (e) => {
      if (e.pointerType === 'mouse') {
        const p = this.pointers.get('mouse');
        if (p) p.active = false;
      } else {
        this.pointers.delete(e.pointerId);
      }
    };
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this._listeners = [
      ['pointerdown', down], ['pointermove', move],
      ['pointerup', up], ['pointercancel', up],
    ];
  }

  _attachKeyEvents() {
    this._keyListener = (e) => {
      if (e.repeat) return;
      const lane = LANE_KEYS[e.code];
      if (lane !== undefined && this.onLaneKey) {
        e.preventDefault();
        this.onLaneKey(lane);
      }
    };
    window.addEventListener('keydown', this._keyListener);
  }

  _entryFor(e) {
    const id = e.pointerType === 'mouse' ? 'mouse' : e.pointerId;
    let p = this.pointers.get(id);
    if (!p) {
      const x = e.clientX / window.innerWidth;
      p = {
        id,
        hand: x < 0.5 ? 'L' : 'R',
        x,
        y: e.clientY / window.innerHeight,
        vx: 0, vy: 0,
        active: e.pointerType !== 'mouse',
        _t: e.timeStamp,
      };
      this.pointers.set(id, p);
    }
    return p;
  }

  _move(p, e) {
    const x = e.clientX / window.innerWidth;
    const y = e.clientY / window.innerHeight;
    const dt = (e.timeStamp - p._t) / 1000;
    if (dt > 0.001) {
      const nvx = ((x - p.x) * this.aspect) / dt;
      const nvy = (y - p.y) / dt;
      p.vx = p.vx + (nvx - p.vx) * VEL_SMOOTH;
      p.vy = p.vy + (nvy - p.vy) * VEL_SMOOTH;
      p._t = e.timeStamp;
    }
    p.x = x;
    p.y = y;
  }

  /** 毎フレーム呼ぶ。カメラモードでは手検出を進める。 */
  update(nowMs) {
    if (this.camera) {
      this.camera.update(nowMs, this.aspect);
      this.pointers = this.camera.pointers;
    } else {
      // イベントが来ないフレームでは速度を減衰させる
      for (const p of this.pointers.values()) {
        const age = nowMs - p._t;
        if (age > 80) { p.vx *= 0.8; p.vy *= 0.8; }
      }
    }
  }

  getPointers() {
    return [...this.pointers.values()];
  }

  teardown() {
    for (const [ev, fn] of this._listeners) window.removeEventListener(ev, fn);
    this._listeners = [];
    if (this._keyListener) {
      window.removeEventListener('keydown', this._keyListener);
      this._keyListener = null;
    }
    if (this.camera) {
      this.camera.stop();
      this.camera = null;
    }
    this.pointers = new Map();
    this.mode = null;
  }
}
