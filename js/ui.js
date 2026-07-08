// kagemai — 画面遷移・HUD・ポップアップ等の DOM まわり

const JUDGE_LABELS = { perfect: '極', good: '良', miss: '逸' };

export class UI {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.screens = [...document.querySelectorAll('.screen')];
    this.judgeLayer = this.$('judge-layer');
    this.countdownEl = this.$('countdown');
    this.toastEl = this.$('toast');
    this.debugEl = this.$('debug-overlay');
    this._toastTimer = 0;
    this.current = null;
  }

  show(name) {
    for (const s of this.screens) s.hidden = s.id !== `screen-${name}`;
    this.current = name;
    document.body.dataset.screen = name;
    // E2E/デバッグ用フック
    if (window.__kagemai) {
      window.__kagemai.screen = name;
      (window.__kagemai.trace ??= []).push(name);
    }
  }

  bind(id, fn) {
    this.$(id).addEventListener('click', fn);
  }

  setHud({ score, combo, progress }) {
    this.$('hud-score').textContent = String(score);
    const comboEl = this.$('hud-combo');
    if (combo >= 3) {
      this.$('hud-combo-n').textContent = String(combo);
      if (comboEl.hidden) comboEl.hidden = false;
      // アニメ再発火
      comboEl.style.animation = 'none';
      void comboEl.offsetWidth;
      comboEl.style.animation = '';
    } else {
      comboEl.hidden = true;
    }
    this.$('hud-progress-bar').style.width = `${(progress * 100).toFixed(1)}%`;
  }

  popJudge(judge, x, y) {
    const el = document.createElement('div');
    el.className = `judge-pop ${judge}`;
    el.textContent = JUDGE_LABELS[judge] ?? judge;
    el.style.left = `${(x * 100).toFixed(1)}%`;
    el.style.top = `${(y * 100).toFixed(1)}%`;
    this.judgeLayer.appendChild(el);
    setTimeout(() => el.remove(), 650);
  }

  countdown(n) {
    if (n === null) {
      this.countdownEl.hidden = true;
    } else {
      this.countdownEl.hidden = false;
      this.countdownEl.textContent = ['', '壱', '弐', '参'][n] ?? String(n);
    }
  }

  toast(msg, ms = 4000) {
    this.toastEl.textContent = msg;
    this.toastEl.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toastEl.hidden = true; }, ms);
  }

  debug(text) {
    if (!this.debugEl.hidden) this.debugEl.textContent = text;
  }

  setDebugVisible(on) {
    this.debugEl.hidden = !on;
    if (!on) this.debugEl.textContent = '';
  }

  setProgress(ratio, label) {
    this.$('analysis-progress').hidden = false;
    this.$('analysis-bar').style.width = `${(ratio * 100).toFixed(0)}%`;
    if (label) this.$('analysis-label').textContent = label;
  }

  hideProgress() {
    this.$('analysis-progress').hidden = true;
  }

  songError(msg) {
    const el = this.$('song-error');
    el.hidden = !msg;
    el.textContent = msg || '';
  }
}
