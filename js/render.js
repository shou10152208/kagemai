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

function makeBgTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#221c14');
  grad.addColorStop(0.45, '#171310');
  grad.addColorStop(1, '#0b0908');
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

    this.noteViews = new Map(); // note.id -> group
    this.fx = [];               // {update(dt,t)->bool}
    this.trails = { L: [], R: [] };
    this.heads = {};

    this._buildBackground();
    this._buildBrushes();
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.setJudgeRadius(this._judgeNormR || 0.09);
    this._layoutBackground();
    this._layoutLanes();
  }

  setCameraMode(on) {
    this.cameraMode = on;
    this.bgGroup.visible = !on;
  }

  setLaneGuides(on) {
    this.laneGroup.visible = on;
  }

  // ---- 背景(非カメラモード) ----
  _buildBackground() {
    this.bgPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: makeBgTexture(), depthWrite: false }),
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
  _buildBrushes() {
    for (const hand of ['L', 'R']) {
      const head = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.dab, color: HAND_COLORS[hand], transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      head.visible = false;
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
      head.scale.setScalar(r * (p.active ? 2.4 : 1.6));
      head.material.opacity = p.active ? 0.95 : 0.5;
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
      const shape = new THREE.Shape();
      shape.moveTo(0.15, -0.55);
      shape.lineTo(0.8, 0);
      shape.lineTo(0.15, 0.55);
      shape.lineTo(0.38, 0);
      shape.closePath();
      const arrow = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({ color: KIN, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }),
      );
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
    // 背景アニメーション
    if (this.bgGroup.visible) {
      for (const b of this.inkBlobs) {
        const ph = b.userData.phase;
        b.position.x += Math.sin(elapsed * 0.07 + ph) * dt * 0.4;
        b.position.y += Math.cos(elapsed * 0.05 + ph) * dt * 0.25;
      }
      const pos = this.dust.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) + dt * 0.25;
        if (y > 10) y = -10;
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
    }
    // エフェクト更新
    this.fx = this.fx.filter((fn) => fn(dt));
    this.renderer.render(this.scene, this.camera);
  }
}
