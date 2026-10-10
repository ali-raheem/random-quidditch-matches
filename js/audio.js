// Procedural sound: every effect is synthesised with Web Audio, so there are no audio
// files and it works offline. Sounds are panned and attenuated by where the event
// happens on screen, and rate-limited so a busy match stays listenable.

const PREF_KEY = 'rqm.sound';
const MAX_VOICES = 20;
// Minimum seconds between two sounds of the same kind.
const MIN_GAP = {
  whistle: 0.4, throw: 0.12, catch: 0.15, save: 0.3, goal: 1, rim: 0.3, bat: 0.12, bonk: 0.2, dodge: 0.3,
  tackle: 0.3, spot: 1.5, near: 0.5, snitch: 2, crash: 1, fumble: 0.3, foul: 1,
};
// Crowd reactions are heard from the stands, not from where the ball is.
const CROWD = new Set(['goal', 'save', 'snitch', 'spot', 'near', 'foul', 'crash']);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function loadPref() {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

function savePref(on) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch { /* storage unavailable; preference just won't persist */ }
}

export class SoundEngine {
  constructor() {
    this.enabled = loadPref();
    this.ctx = null;
    this.last = {};
    this.busy = []; // end times of active voices
    this.excite = 0; // how tense the play is, drives the crowd bed
  }

  // Browsers only allow audio to start from a user gesture; call this from one.
  unlock() {
    if (!this.enabled) return;
    if (!this.ctx) this.init();
    // iOS can also leave the context 'interrupted' (calls, backgrounding).
    if (this.ctx && this.ctx.state !== 'running' && !this.paused) this.ctx.resume();
  }

  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(comp);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // The crowd: a murmuring bed that swells as play gets tense.
    this.crowd = this.loop('bandpass', 750, 0.7, 0.03);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lg = ctx.createGain();
    lg.gain.value = 180;
    lfo.connect(lg).connect(this.crowd.f.frequency);
    lfo.start();
    this.wind = this.loop('lowpass', 380, 0.5, 0);
    this.rain = this.loop('highpass', 4000, 0.3, 0);
  }

  loop(filterType, freq, q, gain) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.master);
    src.start(0, Math.random() * 1.9);
    return { f, g };
  }

  // Weather beds for a new match.
  setWeather(match) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const w = match.weather;
    this.wind.g.gain.setTargetAtTime(clamp(match.wind.speed / 250, 0, 0.07), now, 1);
    this.rain.g.gain.setTargetAtTime(w === 'rain' ? 0.05 : w === 'drizzle' ? 0.02 : 0, now, 1);
  }

  setEnabled(on) {
    this.enabled = on;
    savePref(on);
    if (on) this.unlock();
    else this.ctx?.suspend();
  }

  setPaused(p) {
    this.paused = p;
    if (!this.ctx) return;
    if (p) this.ctx.suspend();
    else if (this.enabled) this.ctx.resume();
  }

  ready() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  // view: the renderer (for project(), w and h).
  ingest(events, view, state) {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    this.busy = this.busy.filter((t) => t > now);
    for (const e of events) {
      const kind = e.type;
      if (!(kind in MIN_GAP)) continue;
      const big = CROWD.has(kind) || kind === 'whistle';
      if (now - (this.last[kind] ?? -1) < MIN_GAP[kind] || (!big && this.busy.length >= MAX_VOICES)) continue;
      const sp = CROWD.has(kind) ? { gain: 1, pan: 0 } : this.spatial(e, view);
      if (!sp) continue;
      this.last[kind] = now;
      this.play(kind, e, sp, now + 0.01);
    }
    // Tension: the Quaffle near a hoop, or a Seeker in a chase.
    if (state) {
      const q = state.quaffle;
      const near = Math.abs(q.x) > 160 ? 1 : Math.abs(q.x) / 160;
      const chase = state.players.some((p) => p.role === 'seeker' && p.mode === 'chase') ? 1 : 0;
      const target = state.over ? 0.4 : 0.25 * near + 0.6 * chase;
      this.excite += (target - this.excite) * 0.01;
      this.crowd.g.gain.setTargetAtTime(0.025 + this.excite * 0.05, now, 0.6);
    }
  }

  spatial(e, view) {
    const { sx, sy } = view.project(e.x, e.y ?? 0, e.z ?? 0);
    const hw = view.w / 2, hh = view.h / 2;
    const dx = (sx - hw) / hw, dy = (sy - hh) / hh;
    const d = Math.hypot(dx, dy); // 1 ≈ screen edge
    if (d > 1.8) return null;
    return { gain: clamp(1.15 - d * 0.5, 0.15, 1), pan: clamp(dx, -1, 1) * 0.7 };
  }

  // --- building blocks -----------------------------------------------------------

  voice(sp, t, dur) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = sp.gain;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = sp.pan;
      g.connect(p).connect(this.master);
    } else {
      g.connect(this.master);
    }
    this.busy.push(t + dur);
    return g;
  }

  tone(dest, type, f0, f1, t, dur, peak, attack = 0.005) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // Exponential ramps throw on a target of 0, which a silent (far-off) sound can ask for.
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  noise(dest, filterType, f0, f1, q, t, dur, peak, attack = 0.003) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // Exponential ramps throw on a target of 0, which a silent (far-off) sound can ask for.
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.8);
    src.stop(t + dur + 0.05);
  }

  // A crowd voice: many people at once, as broadband noise through vowel-ish formants.
  roar(dest, t, dur, peak, rise = 0.25, f0 = 700, f1 = 1000) {
    this.noise(dest, 'bandpass', f0, f1, 0.6, t, dur, peak, rise);
    this.noise(dest, 'bandpass', f0 * 2.4, f1 * 2, 1.2, t, dur * 0.9, peak * 0.5, rise);
  }

  // "Ooh": a pitch-sliding vowel from the stands.
  ooh(dest, t, dur, peak, up = true) {
    const ctx = this.ctx;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 4;
    bp.frequency.setValueAtTime(420, t);
    bp.frequency.linearRampToValueAtTime(up ? 620 : 360, t + dur);
    bp.connect(dest);
    for (const f of [150, 190, 230]) {
      const o = this.tone(bp, 'sawtooth', f * (0.97 + Math.random() * 0.06), f * (up ? 1.15 : 0.82), t, dur, peak, 0.15);
      o.detune.value = Math.random() * 30 - 15;
    }
    this.noise(dest, 'bandpass', 500, up ? 800 : 380, 1, t, dur, peak * 2, 0.15);
  }

  horn(dest, f, t, dur, peak) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(f * 5, t + 0.08);
    lp.frequency.exponentialRampToValueAtTime(f * 3, t + dur);
    lp.connect(dest);
    for (const detune of [-6, 5]) {
      const o = this.tone(lp, 'sawtooth', f, f, t, dur, peak, 0.06);
      o.detune.value = detune;
    }
  }

  // --- the sounds ----------------------------------------------------------------

  play(kind, e, sp, t) {
    const pf = 0.92 + Math.random() * 0.16;
    switch (kind) {
      case 'whistle': {
        // A pea whistle: two close tones, warbling.
        const v = this.voice({ gain: 0.7, pan: sp.pan ?? 0 }, t, 0.5);
        const ctx = this.ctx;
        const trem = ctx.createOscillator();
        trem.frequency.value = 28;
        const tg = ctx.createGain();
        tg.gain.value = 90;
        trem.connect(tg);
        for (const f of [2850, 3020]) {
          const o = this.tone(v, 'sine', f, f * 0.99, t, 0.42, 0.06, 0.01);
          tg.connect(o.frequency);
        }
        trem.start(t);
        trem.stop(t + 0.5);
        this.noise(v, 'bandpass', 3000, 2900, 4, t, 0.4, 0.03, 0.01);
        break;
      }
      case 'throw': {
        const v = this.voice(sp, t, 0.3);
        const shot = e.kind === 'shot';
        this.noise(v, 'bandpass', shot ? 1600 : 1100, shot ? 500 : 400, 1.5, t, shot ? 0.28 : 0.2, shot ? 0.18 : 0.08, 0.02);
        break;
      }
      case 'catch':
      case 'fumble': {
        const v = this.voice(sp, t, 0.15);
        this.tone(v, 'sine', 170 * pf, 90, t, 0.1, 0.18, 0.002);
        this.noise(v, 'lowpass', 1200, 300, 0.8, t, 0.06, 0.15, 0.001);
        break;
      }
      case 'tackle': {
        const v = this.voice(sp, t, 0.2);
        this.noise(v, 'lowpass', 600, 150, 0.8, t, 0.15, 0.2, 0.002);
        break;
      }
      case 'rim': {
        // A metal hoop ringing.
        const v = this.voice(sp, t, 0.9);
        const base = 520 * pf;
        this.tone(v, 'sine', base, base, t, 0.8, 0.07, 0.001);
        this.tone(v, 'sine', base * 2.76, base * 2.74, t, 0.5, 0.04, 0.001);
        this.tone(v, 'sine', base * 5.4, base * 5.3, t, 0.25, 0.02, 0.001);
        this.ooh(this.voice({ gain: 0.6, pan: 0 }, t + 0.1, 1), t + 0.1, 0.9, 0.012, false);
        break;
      }
      case 'bat': {
        // The crack of a bat on iron: a sharp click and a ringing thunk.
        const v = this.voice(sp, t, 0.4);
        const p = clamp(e.power ?? 1, 0.6, 1.4);
        this.noise(v, 'highpass', 3000, 2000, 0.7, t, 0.03, 0.35 * p, 0.0005);
        this.tone(v, 'triangle', 880 * pf, 420, t, 0.12, 0.12 * p, 0.001);
        this.tone(v, 'sine', 210 * pf, 120, t, 0.25, 0.14 * p, 0.002);
        break;
      }
      case 'bonk': {
        const v = this.voice(sp, t, 0.5);
        this.tone(v, 'sine', 95, 45, t, 0.3, 0.3, 0.002);
        this.noise(v, 'lowpass', 900, 120, 0.8, t, 0.25, 0.3, 0.002);
        if (e.ko) this.ooh(this.voice({ gain: 0.8, pan: 0 }, t + 0.15, 1.6), t + 0.15, 1.4, 0.02, false);
        break;
      }
      case 'dodge': {
        const v = this.voice(sp, t, 0.35);
        this.noise(v, 'bandpass', 500, 1800, 1.2, t, 0.3, 0.06, 0.1);
        break;
      }
      case 'save': {
        const v = this.voice(sp, t, 1.6);
        this.ooh(v, t + 0.05, 1.1, 0.018, true);
        this.roar(v, t + 0.1, 1.2, 0.05, 0.2, 650, 800);
        break;
      }
      case 'goal': {
        // The home end erupts: a swelling roar, then applause.
        const v = this.voice(sp, t, 3.5);
        this.roar(v, t, 3, 0.22, 0.25, 700, 1050);
        for (let i = 0; i < 40; i++) {
          this.noise(v, 'bandpass', 2200 + Math.random() * 1500, 1800, 1.5, t + 0.6 + Math.random() * 2.4, 0.03, 0.05 + Math.random() * 0.05, 0.001);
        }
        break;
      }
      case 'spot': {
        const v = this.voice(sp, t, 2.2);
        this.roar(v, t, 2, 0.05, 0.9, 550, 900);
        break;
      }
      case 'near': {
        const v = this.voice(sp, t, 1.4);
        this.ooh(v, t, 1.2, 0.022, true);
        break;
      }
      case 'foul': {
        // Booing from the stands.
        const v = this.voice(sp, t, 1.8);
        this.ooh(v, t + 0.3, 1.4, 0.016, false);
        break;
      }
      case 'crash': {
        const v = this.voice(sp, t, 1.5);
        this.tone(v, 'sine', 80, 35, t, 0.4, 0.3, 0.002);
        this.noise(v, 'lowpass', 500, 80, 0.7, t, 0.5, 0.3, 0.003);
        this.ooh(v, t + 0.2, 1.2, 0.02, false);
        break;
      }
      case 'snitch': {
        const v = this.voice(sp, t, 5);
        this.roar(v, t, 4.5, 0.3, 0.2, 750, 1100);
        break;
      }
    }
  }

  // Trumpets at full time.
  fanfare() {
    if (!this.ready()) return;
    const t = this.ctx.currentTime + 0.4;
    const notes = [261.6, 329.6, 392, 523.3, 392, 523.3];
    const durs = [0.15, 0.15, 0.15, 0.35, 0.15, 1.1];
    const v = this.voice({ gain: 1, pan: 0 }, t, 3);
    let at = t;
    notes.forEach((f, i) => {
      this.horn(v, f, at, durs[i], 0.045);
      this.horn(v, f * 1.5, at, durs[i], 0.02);
      at += durs[i] + 0.03;
    });
  }
}
