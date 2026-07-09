// kagemai — Three.js 描画レイヤー
// カメラモードでは透明背景でカメラ映像の上に重なる。
// 非カメラモードでは和モダンな背景(墨のグラデーション+金の塵)を描く。

import * as THREE from 'three';

export const HAND_COLORS = { L: 0x5878a8, R: 0xd9553b }; // 藍 / 朱
const KIN = 0xc9a24b;
const FOV = 55;
const CAM_DIST = 8;
const SPAWN_Z = -60;

function makeDabTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

// 背景テーマ(非カメラモードのWebGL背景。UI側の色は CSS の body[data-theme])
export const THEMES = {
  sumi:   { label: '墨',   stops: ['#221c14', '#171310', '#0b0908'], dust: 0xc9a24b, blobColor: 0x000000, blobOpacity: 0.4, petal: 0xd9b45a },
  yoi:    { label: '宵',   stops: ['#26304e', '#181f36', '#0b0e1c'], dust: 0x9db8e8, blobColor: 0x060a18, blobOpacity: 0.35, petal: 0xaec6f0 },
  sakura: { label: '桜',   stops: ['#f7e9eb', '#f0d8dd', '#e2bfc9'], dust: 0xd98da0, blobColor: 0xf8b8c8, blobOpacity: 0.3, petal: 0xf5b8c8 },
  washi:  { label: '和紙', stops: ['#f4eddd', '#ece2cb', '#dccfae'], dust: 0xb08d3e, blobColor: 0xd8c8a0, blobOpacity: 0.3, petal: 0xe8a8b8 },
};

/** 矢羽メッシュ(+x向き。単位サイズで作り呼び出し側でスケール) */
function makeArrowMesh(color) {
  const shape = new THREE.Shape();
  shape.moveTo(0.15, -0.55);
  shape.lineTo(0.8, 0);
  shape.lineTo(0.15, 0.55);
  shape.lineTo(0.38, 0);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.translate(-0.475, 0, 0); // 回転が図形の中心まわりになるよう原点へ寄せる
  return new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    }),
  );
}

/** 花びらテクスチャ(白で描いて material.color で染める) */
function makePetalTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2);
  const grad = g.createRadialGradient(0, -size * 0.1, 0, 0, 0, size * 0.45);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(1, 'rgba(255,255,255,0.55)');
  g.fillStyle = grad;
  // 桜の花びら: しずく形+先端の切れ込み
  g.beginPath();
  g.moveTo(0, -size * 0.42);
  g.bezierCurveTo(size * 0.3, -size * 0.28, size * 0.26, size * 0.18, 0, size * 0.4);
  g.bezierCurveTo(-size * 0.26, size * 0.18, -size * 0.3, -size * 0.28, 0, -size * 0.42);
  g.fill();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.arc(0, -size * 0.5, size * 0.11, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
}

function makeBgTexture(stops) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, stops[0]);
  grad.addColorStop(0.45, stops[1]);
  grad.addColorStop(1, stops[2]);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 512);
  return new THREE.CanvasTexture(c);
}

export class Stage {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 250);
    this.camera.position.set(0, 0, CAM_DIST);

    this.dab = makeDabTexture();
    this.noteGroup = new THREE.Group();
    this.fxGroup = new THREE.Group();
    this.bgGroup = new THREE.Group();
    this.brushGroup = new THREE.Group();
    this.laneGroup = new THREE.Group();
    this.scene.add(this.bgGroup, this.laneGroup, this.noteGroup, this.fxGroup, this.brushGroup);

    this.noteViews = new Map();   // note.id -> group
    this.strokeViews = new Map(); // stroke.id -> view(舞モード)
    this.flagViews = new Map();   // cmd.id -> view(旗印モード)
    this.fx = [];                 // {update(dt,t)->bool}
    this.trails = { L: [], R: [] };
    this.heads = {};
    this._pulse = 0;
    this.feverOn = false;
    this.highlightOn = false;   // 華の刻(曲の高揚区間)
    this._music = 0;            // 音楽エネルギー(平滑化済み 0..1)
    this._musicTarget = 0;
    this.quality = 1;           // 動的品質(FPS低下時に 0.5)

    // フィーバー/拍パルス用の金色オーバーレイ(カメラモードでも使う)
    this.feverOverlay = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: KIN, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    this.feverOverlay.position.z = 3;
    this.scene.add(this.feverOverlay);

    this._buildBackground();
    this._buildBrushes();
    this._buildPetals();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // 画面正規化座標(0..1) → z平面上のワールド座標
  planeSize(z = 0) {
    const d = CAM_DIST - z;
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * d;
    return { w: h * this.camera.aspect, h };
  }

  worldFromNorm(nx, ny, z = 0) {
    const { w, h } = this.planeSize(0);
    return new THREE.Vector3((nx - 0.5) * w, (0.5 - ny) * h, z);
  }

  /** 判定半径(高さ正規化)に対応するワールド半径 */
  get noteWorldRadius() {
    return this._noteR;
  }

  setJudgeRadius(normRadius) {
    this._judgeNormR = normRadius;
    this._noteR = normRadius * this.planeSize(0).h;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    // スマホ負荷対策: タッチ端末は描画解像度を抑えて 30fps を維持する
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.setJudgeRadius(this._judgeNormR || 0.09);
    this._layoutBackground();
    this._layoutLanes();
    if (this.feverOverlay) {
      const { w: fw, h: fh } = this.planeSize(3);
      this.feverOverlay.scale.set(fw * 1.1, fh * 1.1, 1);
    }
  }

  setCameraMode(on) {
    this.cameraMode = on;
    this.bgGroup.visible = !on;
  }

  setLaneGuides(on) {
    this.laneGroup.visible = on;
  }

  // ---- 背景(非カメラモード) ----
  /** 背景テーマを切り替える(name: THEMES のキー) */
  setTheme(name) {
    const theme = THEMES[name] || THEMES.sumi;
    this._theme = theme;
    const old = this.bgPlane.material.map;
    this.bgPlane.material.map = makeBgTexture(theme.stops);
    this.bgPlane.material.needsUpdate = true;
    if (old) old.dispose();
    this.dust.material.color.setHex(theme.dust);
    for (const b of this.inkBlobs) {
      b.material.color.setHex(theme.blobColor);
      b.material.opacity = theme.blobOpacity;
    }
    if (this.petals) {
      for (const p of this.petals) p.material.color.setHex(theme.petal);
    }
  }

  _buildBackground() {
    this.bgPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: makeBgTexture(THEMES.sumi.stops), depthWrite: false }),
    );
    this.bgPlane.position.z = -80;
    this.bgGroup.add(this.bgPlane);

    // 墨のにじみ(ゆっくり漂う暗い斑)
    this.inkBlobs = [];
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.dab, color: 0x000000, opacity: 0.4, depthWrite: false,
      }));
      s.position.set((i - 1) * 8, (i % 2) * 5 - 2, -38 - i * 6);
      s.scale.setScalar(26 + i * 8);
      s.userData.phase = i * 2.1;
      s.userData.baseScale = 26 + i * 8;
      this.inkBlobs.push(s);
      this.bgGroup.add(s);
    }

    // 金の塵
    const n = 60;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 30;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 20;
      pos[i * 3 + 2] = -Math.random() * 40;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(geo, new THREE.PointsMaterial({
      color: KIN, size: 0.09, map: this.dab, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.bgGroup.add(this.dust);
  }

  _layoutBackground() {
    const { w, h } = this.planeSize(-80);
    this.bgPlane.scale.set(w * 1.05, h * 1.05, 1);
  }

  _layoutLanes() {
    this.laneGroup.clear();
    const { w, h } = this.planeSize(0);
    for (let i = 1; i < 4; i++) {
      const geo = new THREE.PlaneGeometry(0.02, h * 1.4);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xe8e0cf, transparent: true, opacity: 0.07, depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.set((i / 4 - 0.5) * w, 0, 0.01);
      this.laneGroup.add(m);
    }
    this.laneGroup.visible = false;
  }

  // ---- 光の筆(ポインタ追従) ----
  // 自分の手は「白熱コア+色付きグロー+細リング」の彗星スタイルにして、
  // お手本(淡い墨点のガイド)と見分けられる画面で一番明るい存在にする
  _buildBrushes() {
    for (const hand of ['L', 'R']) {
      const head = new THREE.Group();
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.dab, color: HAND_COLORS[hand], transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.scale.setScalar(2.6);
      const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.dab, color: 0xffffff, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      core.scale.setScalar(1.0);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.35, 1.5, 40),
        new THREE.MeshBasicMaterial({
          color: HAND_COLORS[hand], transparent: true, opacity: 0.9,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      head.add(glow, core, ring);
      head.visible = false;
      head.userData = { glow, core, ring };
      this.heads[hand] = head;
      this.brushGroup.add(head);
      const pool = [];
      for (let i = 0; i < 26; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.dab, color: HAND_COLORS[hand], transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        s.userData.life = 0;
        pool.push(s);
        this.brushGroup.add(s);
      }
      this.trails[hand] = { pool, idx: 0 };
    }
  }

  updatePointers(pointers, dt) {
    const seen = { L: false, R: false };
    const r = this._noteR;
    for (const p of pointers) {
      const hand = p.hand === 'L' ? 'L' : 'R';
      const head = this.heads[hand];
      const pos = this.worldFromNorm(p.x, p.y, 0.4);
      head.position.copy(pos);
      head.scale.setScalar(r * (p.active ? 0.75 : 0.55));
      const { glow, core, ring } = head.userData;
      glow.material.opacity = p.active ? 0.9 : 0.45;
      core.material.opacity = p.active ? 0.95 : 0.5;
      ring.material.opacity = p.active ? 0.9 : 0.45;
      head.visible = true;
      seen[hand] = true;
      // 軌跡を落とす
      const trail = this.trails[hand];
      const s = trail.pool[trail.idx];
      trail.idx = (trail.idx + 1) % trail.pool.length;
      s.position.copy(pos);
      s.userData.life = 1;
      s.scale.setScalar(r * 1.5);
    }
    for (const hand of ['L', 'R']) {
      if (!seen[hand]) this.heads[hand].visible = false;
      for (const s of this.trails[hand].pool) {
        if (s.userData.life > 0) {
          s.userData.life = Math.max(0, s.userData.life - dt * 2.4);
          const l = s.userData.life;
          s.material.opacity = 0.4 * l;
          s.scale.setScalar(this._noteR * (0.5 + 1.3 * l));
        } else {
          s.material.opacity = 0;
        }
      }
    }
  }

  // ---- ノーツ ----
  _createNoteView(note) {
    const g = new THREE.Group();
    const color = HAND_COLORS[note.hand];
    const r = 1; // 単位半径で作り、グループを noteWorldRadius でスケール

    const core = new THREE.Mesh(
      new THREE.CircleGeometry(r * 0.78, 40),
      new THREE.MeshBasicMaterial({ color: 0x120e0b, transparent: true, opacity: 0.88, depthWrite: false }),
    );
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.78, r * 1.0, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }),
    );
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.dab, color, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.scale.setScalar(r * 3.2);
    g.add(glow, core, rim);

    if (note.type === 'swipe') {
      // 払う方向を示す矢羽
      const arrow = makeArrowMesh(KIN);
      arrow.material.opacity = 0.95;
      arrow.scale.setScalar(r * 0.9);
      arrow.rotation.z = Math.atan2(-note.dir.y, note.dir.x);
      arrow.position.z = 0.02;
      g.add(arrow);
    }

    // 到達目標の環(判定プレーン上)
    const target = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.05, r * 1.13, 48),
      new THREE.MeshBasicMaterial({ color: KIN, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
    );
    target.position.copy(this.worldFromNorm(note.x, note.y, 0));
    target.scale.setScalar(this._noteR);
    this.noteGroup.add(target);

    const world = this.worldFromNorm(note.x, note.y, 0);
    g.position.set(world.x, world.y, SPAWN_Z);
    g.scale.setScalar(this._noteR);
    this.noteGroup.add(g);
    const view = { group: g, target, note };
    this.noteViews.set(note.id, view);
    return view;
  }

  /**
   * ライブノーツを同期する。notes は未判定ノーツの配列。
   * progress = (songTime - (time - lead)) / lead(0で出現、1で判定プレーン到達)
   */
  syncNotes(notes, songTime, lead) {
    const alive = new Set();
    for (const n of notes) {
      const t = (songTime - (n.time - lead)) / lead;
      if (t < 0) continue;
      alive.add(n.id);
      const view = this.noteViews.get(n.id) || this._createNoteView(n);
      const z = SPAWN_Z * (1 - Math.min(t, 1.15));
      view.group.position.z = z;
      // 出現直後はフェードイン
      const fade = Math.min(1, t / 0.12);
      view.group.visible = true;
      view.group.scale.setScalar(this._noteR * (0.85 + 0.15 * Math.min(t, 1)));
      view.group.children[0].material.opacity = 0.55 * fade; // glow
      view.group.children[1].material.opacity = 0.88 * fade; // core
      view.group.children[2].material.opacity = 0.95 * fade; // rim
      if (view.group.children[3]) view.group.children[3].material.opacity = 0.95 * fade; // 矢羽
      // 目標環: 到達0.7秒前から収縮しつつ現れる
      const remain = n.time - songTime;
      if (remain < 0.7) {
        const k = 1 - Math.max(0, remain / 0.7);
        view.target.material.opacity = 0.7 * k;
        view.target.scale.setScalar(this._noteR * (2.0 - 1.0 * k));
      }
    }
    // 判定済み/範囲外のビューを破棄
    for (const [id, view] of this.noteViews) {
      if (!alive.has(id)) this._disposeNoteView(id, view);
    }
  }

  _disposeNoteView(id, view) {
    this.noteGroup.remove(view.group);
    this.noteGroup.remove(view.target);
    view.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    view.target.geometry.dispose();
    view.target.material.dispose();
    this.noteViews.delete(id);
  }

  // ---- 桜吹雪(華の刻・フィーバー中に舞う) ----
  _buildPetals() {
    this.petalTexture = makePetalTexture();
    this.petalGroup = new THREE.Group();
    this.scene.add(this.petalGroup);
    this.petals = [];
    for (let i = 0; i < 70; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.petalTexture, color: THEMES.sumi.petal,
        transparent: true, opacity: 0, depthWrite: false,
      }));
      s.visible = false;
      s.userData = { active: false };
      this.petals.push(s);
      this.petalGroup.add(s);
    }
    this._petalTimer = 0;
  }

  _spawnPetal() {
    const p = this.petals.find((s) => !s.userData.active);
    if (!p) return;
    const z = -6 - Math.random() * 14;
    const { w, h } = this.planeSize(z);
    const u = p.userData;
    u.active = true;
    u.z = z;
    u.vy = -(0.35 + Math.random() * 0.4) * h * 0.14;   // 落下速度(奥行きに比例)
    u.sway = 0.6 + Math.random() * 0.8;
    u.phase = Math.random() * Math.PI * 2;
    u.rot = (Math.random() - 0.5) * 3;
    p.position.set((Math.random() - 0.5) * w, h * 0.55, z);
    p.scale.setScalar(h * (0.014 + Math.random() * 0.012));
    p.material.rotation = Math.random() * Math.PI * 2;
    p.material.opacity = 0.85;
    p.visible = true;
  }

  _updatePetals(dt, elapsed) {
    const emitting = this.highlightOn || this.feverOn;
    if (emitting) {
      this._petalTimer += dt;
      const interval = 1 / (12 * this.quality); // 秒あたりの発生数
      while (this._petalTimer > interval) {
        this._petalTimer -= interval;
        this._spawnPetal();
      }
    }
    for (const p of this.petals) {
      const u = p.userData;
      if (!u.active) continue;
      p.position.y += u.vy * dt;
      p.position.x += Math.sin(elapsed * u.sway + u.phase) * dt * 0.8;
      p.material.rotation += u.rot * dt;
      const { h } = this.planeSize(u.z);
      if (p.position.y < -h * 0.6) {
        u.active = false;
        p.visible = false;
      } else if (!emitting) {
        // 発生停止後はフェードアウト
        p.material.opacity -= dt * 0.5;
        if (p.material.opacity <= 0) { u.active = false; p.visible = false; }
      }
    }
  }

  // ---- 打ち上げ花火(高揚区間のピーク等) ----
  fireworks(count = 1) {
    for (let i = 0; i < count; i++) {
      this._launchFirework(i * 0.35);
    }
  }

  _launchFirework(delay = 0) {
    const colors = [0xc9a24b, 0xd9553b, 0x5878a8];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const { w, h } = this.planeSize(-10);
    const x = (Math.random() - 0.5) * w * 0.7;
    const burstY = h * (0.05 + Math.random() * 0.22);

    const streak = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.dab, color: 0xf0e0b8, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    streak.position.set(x, -h * 0.55, -10);
    streak.scale.setScalar(h * 0.02);
    this.fxGroup.add(streak);

    const RISE = 0.55;
    const N = 34;
    let t = -delay;
    let exploded = false;
    let sparks = null;
    this.fx.push((dt) => {
      t += dt;
      if (t < 0) return true;
      if (t < RISE) {
        // 上昇
        const k = t / RISE;
        streak.material.opacity = 0.9 * (1 - k * 0.4);
        streak.position.y = -h * 0.55 + (burstY + h * 0.55) * (1 - (1 - k) * (1 - k));
        return true;
      }
      if (!exploded) {
        exploded = true;
        this.fxGroup.remove(streak);
        streak.material.dispose();
        sparks = [];
        for (let i = 0; i < N; i++) {
          const s = new THREE.Sprite(new THREE.SpriteMaterial({
            map: this.dab, color, transparent: true, opacity: 1,
            blending: THREE.AdditiveBlending, depthWrite: false,
          }));
          s.position.set(x, burstY, -10);
          const a = (i / N) * Math.PI * 2;
          const speed = h * (0.18 + Math.random() * 0.1);
          s.userData.v = new THREE.Vector3(Math.cos(a) * speed, Math.sin(a) * speed, 0);
          s.userData.tw = Math.random() * Math.PI * 2;
          s.scale.setScalar(h * 0.016);
          sparks.push(s);
          this.fxGroup.add(s);
        }
      }
      const life = (t - RISE) / 1.3;
      for (const s of sparks) {
        s.position.addScaledVector(s.userData.v, dt);
        s.userData.v.multiplyScalar(0.97);
        s.userData.v.y -= h * 0.06 * dt; // 重力
        s.material.opacity = Math.max(0, (1 - life)) * (0.65 + 0.35 * Math.sin(t * 24 + s.userData.tw));
      }
      if (life >= 1) {
        for (const s of sparks) { this.fxGroup.remove(s); s.material.dispose(); }
        return false;
      }
      return true;
    });
  }

  /** 華の刻(曲の高揚区間)の切替 */
  setHighlight(on) {
    this.highlightOn = on;
  }

  /** 音楽エネルギー(0..1)。背景の脈動に使う */
  setMusicLevel(v) {
    this._musicTarget = Math.max(0, Math.min(1, v));
  }

  /** 動的品質(FPS低下時に負荷を下げる) */
  setQuality(q) {
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q < 1 ? 1 : 2));
  }

  // ---- 舞モード: ストローク(なぞりノーツ)描画 ----
  _createStrokeView(stroke, samples) {
    const g = new THREE.Group();
    // お手本は淡い低彩度の墨点(非加算)。自分の手(白熱の彗星)と混同しないよう
    // 意図的に地味にし、なぞれた部分だけ金の加算発光に変わる
    const guideColor = new THREE.Color(HAND_COLORS[stroke.hand]).lerp(new THREE.Color(0xcfc6b2), 0.5);
    const dabs = [];
    for (const s of samples) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.dab, color: guideColor, transparent: true, opacity: 0,
        blending: THREE.NormalBlending, depthWrite: false,
      }));
      sp.position.copy(this.worldFromNorm(s.x, s.y, 0));
      sp.scale.setScalar(this._noteR * 0.62);
      dabs.push(sp);
      g.add(sp);
    }
    // 進行ヘッド(いまなぞるべき位置を示す金の光)
    const head = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.dab, color: KIN, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    head.scale.setScalar(this._noteR * 2.0);
    g.add(head);
    this.noteGroup.add(g);
    const view = { group: g, dabs, head };
    this.strokeViews.set(stroke.id, view);
    return view;
  }

  /**
   * ライブストロークを同期する。
   * liveStrokes: [{stroke:{id,tStart,tEnd}, samples, covered:Uint8Array}]
   */
  syncStrokes(liveStrokes, t, appearLead) {
    const alive = new Set();
    for (const ls of liveStrokes) {
      alive.add(ls.stroke.id);
      const view = this.strokeViews.get(ls.stroke.id) || this._createStrokeView(ls.stroke, ls.samples);
      const { tStart, tEnd } = ls.stroke;
      const fadeIn = Math.max(0, Math.min(1, (t - (tStart - appearLead)) / 0.4));
      const active = t >= tStart - 0.15;
      for (let i = 0; i < view.dabs.length; i++) {
        const d = view.dabs[i];
        if (ls.covered[i]) {
          if (d.material.blending !== THREE.AdditiveBlending) {
            // なぞれた墨点は金の光に変わる
            d.material.color.setHex(KIN);
            d.material.blending = THREE.AdditiveBlending;
            d.material.needsUpdate = true;
          }
          d.material.opacity = 0.95;
          d.scale.setScalar(this._noteR * 1.35);
        } else {
          d.material.opacity = fadeIn * (active ? 0.5 : 0.25);
        }
      }
      if (t >= tStart - 0.05 && t <= tEnd + 0.1) {
        const u = Math.max(0, Math.min(1, (t - tStart) / (tEnd - tStart)));
        const idx = Math.min(ls.samples.length - 1, Math.round(u * (ls.samples.length - 1)));
        const s = ls.samples[idx];
        view.head.position.copy(this.worldFromNorm(s.x, s.y, 0.1));
        view.head.material.opacity = 0.85;
      } else {
        view.head.material.opacity = 0;
      }
    }
    for (const [id, view] of this.strokeViews) {
      if (!alive.has(id)) this._disposeStrokeView(id, view);
    }
  }

  _disposeStrokeView(id, view) {
    this.noteGroup.remove(view.group);
    view.group.traverse((o) => { if (o.material) o.material.dispose(); });
    this.strokeViews.delete(id);
  }

  clearStrokes() {
    for (const [id, view] of [...this.strokeViews]) this._disposeStrokeView(id, view);
  }

  // ---- 旗印モード: 矢印出題の表示 ----
  _createFlagView(cmd) {
    const g = new THREE.Group();
    const color = cmd.hand === 'B' ? KIN : HAND_COLORS[cmd.hand];
    const dir = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[cmd.dir];
    const rot = Math.atan2(-dir.y, dir.x);
    const xs = cmd.hand === 'B' ? [0.28, 0.72] : [cmd.hand === 'L' ? 0.28 : 0.72];
    const arrows = [];
    const rings = [];
    for (const nx of xs) {
      const pos = this.worldFromNorm(nx, 0.42, 0.2);
      const arrow = makeArrowMesh(color);
      arrow.position.copy(pos);
      arrow.rotation.z = rot;
      g.add(arrow);
      arrows.push(arrow);
      // 「今!」を示す収縮リング
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.5, 1.62, 48),
        new THREE.MeshBasicMaterial({
          color: KIN, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      ring.position.copy(pos);
      g.add(ring);
      rings.push(ring);
    }
    this.noteGroup.add(g);
    const view = { group: g, arrows, rings };
    this.flagViews.set(cmd.id, view);
    return view;
  }

  /** ライブ出題を同期する。liveFlags: [{cmd:{id,time,hand,dir}}] */
  syncFlags(liveFlags, t, appearLead) {
    const alive = new Set();
    for (const lf of liveFlags) {
      alive.add(lf.cmd.id);
      const view = this.flagViews.get(lf.cmd.id) || this._createFlagView(lf.cmd);
      const k = Math.max(0, Math.min(1, (t - (lf.cmd.time - appearLead)) / appearLead));
      const remain = lf.cmd.time - t;
      // 予告: 小さく淡く → ビートに向けて拡大・明瞭化。直前は脈打つ
      const pulse = Math.abs(remain) < 0.12 ? 1.15 : 1;
      const scale = this._noteR * (0.9 + 0.5 * k) * pulse;
      for (const a of view.arrows) {
        a.scale.setScalar(scale);
        a.material.opacity = 0.25 + 0.7 * k;
      }
      for (const ring of view.rings) {
        if (remain < 0.7 && remain > -0.45) {
          const rk = 1 - Math.max(0, remain / 0.7);
          ring.material.opacity = 0.75 * rk;
          ring.scale.setScalar(this._noteR * (1.7 - 0.75 * rk));
        } else {
          ring.material.opacity = 0;
        }
      }
    }
    for (const [id, view] of this.flagViews) {
      if (!alive.has(id)) this._disposeFlagView(id, view);
    }
  }

  _disposeFlagView(id, view) {
    this.noteGroup.remove(view.group);
    view.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.flagViews.delete(id);
  }

  clearFlags() {
    for (const [id, view] of [...this.flagViews]) this._disposeFlagView(id, view);
  }

  /** フィーバー(舞ゲージ満タン)の映像効果の切替 */
  setFever(on) {
    this.feverOn = on;
  }

  /** 拍に合わせた画面の微かな明滅(舞モード) */
  beatPulse() {
    this._pulse = 1;
  }

  // ---- ヒットエフェクト ----
  hitFx(nx, ny, judge) {
    const colors = { perfect: KIN, good: 0x8fa8cc, miss: 0x4a443c };
    const color = colors[judge] ?? KIN;
    const pos = this.worldFromNorm(nx, ny, 0.2);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.0, 48),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
        blending: judge === 'miss' ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    ring.position.copy(pos);
    this.fxGroup.add(ring);

    const shards = [];
    if (judge !== 'miss') {
      for (let i = 0; i < 6; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.dab, color, transparent: true, opacity: 0.9,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        s.position.copy(pos);
        const a = (i / 6) * Math.PI * 2 + Math.random();
        s.userData.v = new THREE.Vector3(Math.cos(a), Math.sin(a), 0).multiplyScalar(4 + Math.random() * 3);
        s.scale.setScalar(this._noteR * 0.8);
        shards.push(s);
        this.fxGroup.add(s);
      }
    }

    const dur = 0.4;
    let t = 0;
    const baseR = this._noteR;
    this.fx.push((dt) => {
      t += dt;
      const k = Math.min(1, t / dur);
      ring.scale.setScalar(baseR * (1 + k * 1.6));
      ring.material.opacity = 0.9 * (1 - k);
      for (const s of shards) {
        s.position.addScaledVector(s.userData.v, dt);
        s.userData.v.multiplyScalar(0.92);
        s.material.opacity = 0.9 * (1 - k);
      }
      if (k >= 1) {
        this.fxGroup.remove(ring);
        ring.geometry.dispose();
        ring.material.dispose();
        for (const s of shards) { this.fxGroup.remove(s); s.material.dispose(); }
        return false;
      }
      return true;
    });
  }

  clearNotes() {
    for (const [id, view] of [...this.noteViews]) this._disposeNoteView(id, view);
  }

  render(dt, elapsed) {
    // 音楽エネルギーの平滑化(背景の呼吸)
    this._music += (this._musicTarget - this._music) * Math.min(1, dt * 6);
    const music = this._music;

    // 背景アニメーション
    if (this.bgGroup.visible) {
      for (const b of this.inkBlobs) {
        const ph = b.userData.phase;
        b.position.x += Math.sin(elapsed * 0.07 + ph) * dt * 0.4;
        b.position.y += Math.cos(elapsed * 0.05 + ph) * dt * 0.25;
        b.scale.setScalar(b.userData.baseScale * (1 + 0.16 * music)); // 低音で膨らむ
      }
      const pos = this.dust.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) + dt * (0.25 + music * 0.6);
        if (y > 10) y = -10;
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
      this.dust.material.opacity = 0.35 + 0.35 * music;
    }

    // 桜吹雪
    this._updatePetals(dt, elapsed);

    // フィーバー/華の刻/拍パルスのオーバーレイ
    this._pulse = Math.max(0, this._pulse - dt * 4);
    const feverGlow = this.feverOn ? 0.09 + 0.04 * Math.sin(elapsed * 6) : 0;
    const highlightGlow = this.highlightOn ? 0.045 + 0.02 * music : 0;
    this.feverOverlay.material.opacity = Math.min(0.2, feverGlow + highlightGlow + this._pulse * 0.06);
    // エフェクト更新
    this.fx = this.fx.filter((fn) => fn(dt));
    this.renderer.render(this.scene, this.camera);
  }
}
