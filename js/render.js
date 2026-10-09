// Canvas renderer: an oblique view of the pitch and stands, the players on their
// brooms, the four balls, particles, lighting and weather.
// Purely cosmetic randomness here uses Math.random; it never feeds back into the sim.

import { createRng } from './rng.js';
import { HALF_L, HALF_W, HOOP_X, HOOP_R, HOOPS, SCORING_X, CENTRE_R, edgePoint } from './pitch.js';
import { CREST_SHAPES, GLYPHS } from './crest.js';

const TAU = Math.PI * 2;
// Projection: the pitch is turned by YAW so the hoops at each end don't line up behind
// one another, then ground depth is squashed by K and altitude lifts by H. Everything
// below works in these projected units.
export const K = 0.6;
export const H = 0.8;
const YAW = 0.42;
const CY = Math.cos(YAW), SY = Math.sin(YAW);
export const P = (x, y, z = 0) => [x * CY - y * SY, (x * SY + y * CY) * K - z * H];
const depth = (x, y) => x * SY + y * CY; // larger is nearer the camera
const S = 3.6; // stadium canvas pixels per projected unit
const EXT = (() => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 64; i++) {
    const [ex, ey] = edgePoint((i / 64) * TAU, 80);
    const [px, py] = P(ex, ey);
    x0 = Math.min(x0, px);
    x1 = Math.max(x1, px);
    y0 = Math.min(y0, py);
    y1 = Math.max(y1, py);
  }
  return { x0: Math.floor(x0), x1: Math.ceil(x1), y0: Math.floor(y0 - 90 * H), y1: Math.ceil(y1) };
})();
const MAX_PARTICLES = 1500;
const rand = (a, b) => a + (b - a) * Math.random();
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const GRASS = {
  normal: { base: [104, 40, 33], stripe: [100, 42, 38], apron: [108, 30, 24] },
  wet: { base: [112, 38, 27], stripe: [108, 40, 31], apron: [115, 28, 19] },
  snow: { base: [205, 16, 86], stripe: [205, 12, 91], apron: [210, 14, 74] },
};
const BACKDROP = { day: '#2b4527', evening: '#3b3322', night: '#080c16' };
const hsl = ([h, s, l], a = 1) => `hsl(${h} ${s}% ${l}% / ${a})`;
const CROWD = ['#e6d3b0', '#c9a27a', '#8c6a4e', '#5b4636', '#d8d8d8', '#2b2b2b', '#a83b32', '#3a5d9c'];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.showNames = true;
    this.stadium = document.createElement('canvas');
    this.stadium.width = (EXT.x1 - EXT.x0) * S;
    this.stadium.height = (EXT.y1 - EXT.y0) * S;
    this.trails = new Map();
    this.weather = [];
    this.clouds = [];
    this.flash = null;
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    // Keep the action clear of the scoreboard (top) and controls/feed (bottom).
    this.viewTop = this.h > 500 ? 96 : 70;
    this.viewBottom = 56;
    this.viewH = Math.max(100, this.h - this.viewTop - this.viewBottom);
    this.centerY = this.viewTop + this.viewH / 2;
    this.vignette = null;
    this.makeWeather();
  }

  reset(state) {
    this.state = state;
    this.particles = [];
    this.trails = new Map();
    this.flash = null;
    this.teams = state.teams;
    const m = state.match;
    this.time = m.time;
    this.grass = m.weather === 'snow' ? GRASS.snow : m.weather === 'rain' || m.weather === 'drizzle' ? GRASS.wet : GRASS.normal;
    this.makeStadium(state);
    this.makeWeather();
    this.clouds = [];
    if (['clear', 'wind', 'overcast', 'sunny'].includes(m.weather) && m.time === 'day') {
      for (let i = 0; i < 6; i++) this.clouds.push({ x: rand(-400, 400), y: rand(-120, 120), r: rand(50, 120) });
    }
    this.fitCamera(state, 1, true);
  }

  // Screen position of a world point, for spatial audio.
  project(x, y, z) {
    const z0 = this.cam.zoom;
    const [px, py] = P(x, y, z);
    return { sx: this.w / 2 + (px - this.cam.x) * z0, sy: this.centerY + (py - this.cam.y) * z0 };
  }

  // --- camera ---------------------------------------------------------------------

  fitCamera(state, dt, snap = false) {
    const pts = [];
    const add = (o, pad = 0) => {
      const [px, py] = P(o.x, o.y, o.z);
      pts.push([px - pad, py - pad], [px + pad, py + pad]);
    };
    const q = state.quaffle;
    const s = state.snitch;
    const chasers = state.players.filter((p) => p.role === 'seeker' && p.mode === 'chase' && !p.out);
    const close = chasers.some((p) => Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) < 45);
    if (state.over && state.catcher) {
      add(state.catcher, 55);
    } else if (state.phase === 'lineup' || state.phase === 'release') {
      add({ x: -150, y: 0, z: 0 }, 20);
      add({ x: 150, y: 0, z: 0 }, 20);
    } else if (close) {
      // A Snitch chase takes over the broadcast.
      for (const p of chasers) add(p, 22);
      add(s, 22);
    } else {
      add(q, 75);
      if (q.holder) add(q.holder, 40);
      for (const p of chasers) add(p, 15);
      if (chasers.length) add(s, 15);
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const bw = maxX - minX, bh = maxY - minY;
    // Never zoom out past the whole stadium, nor in past ~120 ft across.
    const whole = Math.min(this.w / (EXT.x1 - EXT.x0 - 60), this.viewH / (EXT.y1 - EXT.y0 - 60));
    const zoom = clamp(Math.min(this.w / bw, this.viewH / bh), whole, Math.max(whole, Math.min(this.w / 160, this.viewH / 90)));
    const tx = clamp((minX + maxX) / 2, EXT.x0 + 60, EXT.x1 - 60), ty = clamp((minY + maxY) / 2, EXT.y0 + 60, EXT.y1 - 30);
    const k = snap ? 1 : Math.min(1, dt * 1.2);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.cam.zoom = Math.exp(Math.log(this.cam.zoom) + (Math.log(zoom) - Math.log(this.cam.zoom)) * k * 0.8);
  }

  // --- the stadium: drawn once per match into an offscreen canvas ------------------

  pitchPath(g, grow = 0) {
    g.beginPath();
    for (let i = 0; i <= 96; i++) {
      const [x, y] = P(...edgePoint((i / 96) * TAU, grow));
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.closePath();
  }

  makeStadium(state) {
    const g = this.stadium.getContext('2d');
    const m = state.match;
    const rng = createRng((state.seed * 2654435761) >>> 0);
    const gr = this.grass;
    g.setTransform(S, 0, 0, S, -EXT.x0 * S, -EXT.y0 * S);
    g.fillStyle = BACKDROP[m.time];
    g.fillRect(EXT.x0, EXT.y0, EXT.x1 - EXT.x0, EXT.y1 - EXT.y0);

    // Surrounding grounds and the apron around the pitch.
    this.pitchPath(g, 70);
    g.fillStyle = hsl(gr.apron);
    g.fill();
    this.pitchPath(g, 0);
    g.fillStyle = hsl(gr.base);
    g.fill();
    g.save();
    this.pitchPath(g, 0);
    g.clip();
    g.fillStyle = hsl(gr.stripe);
    for (let x = -HALF_L; x < HALF_L; x += 50) this.quad(g, x, -HALF_W, x + 25, HALF_W);
    // Worn patches and texture.
    for (let i = 0; i < 160; i++) {
      const [x, y] = P(rng.range(-HALF_L, HALF_L), rng.range(-HALF_W, HALF_W)), r = rng.range(4, 18);
      g.fillStyle = hsl(gr.base, rng.range(0.1, 0.3));
      g.beginPath();
      g.ellipse(x, y, r, r * K, 0, 0, TAU);
      g.fill();
    }
    g.restore();

    // Markings: boundary, centre circle, scoring areas.
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 0.9;
    this.pitchPath(g, 0);
    g.stroke();
    g.lineWidth = 0.6;
    g.beginPath();
    g.ellipse(0, 0, CENTRE_R, CENTRE_R * K, 0, 0, TAU);
    g.stroke();
    g.beginPath();
    g.ellipse(0, 0, 30, 30 * K, 0, 0, TAU);
    g.stroke();
    this.line(g, 0, -HALF_W, 0, HALF_W);
    g.save();
    this.pitchPath(g, 0);
    g.clip();
    for (const s of [-1, 1]) {
      const [hx, hy] = P(s * HOOP_X, 0);
      const R = HOOP_X - SCORING_X + 8;
      g.beginPath();
      g.ellipse(hx, hy, R, R * K, 0, 0, TAU);
      g.stroke();
      g.setLineDash([3, 3]);
      this.line(g, s * SCORING_X, -HALF_W, s * SCORING_X, HALF_W);
      g.setLineDash([]);
      for (const h of HOOPS) {
        const [bx, by] = P(s * HOOP_X, h.y);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.beginPath();
        g.ellipse(bx, by, 2.2, 2.2 * K, 0, 0, TAU);
        g.fill();
      }
    }
    g.restore();

    // The stands: a ring of draped towers, short along the near side so they never
    // hide the pitch.
    this.towers = [];
    const n = 40;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + 0.04;
      const [gx, gy] = edgePoint(a, 34);
      const d = depth(gx, gy);
      const near = d > 30;
      const team = i % 3 === 0 ? 1 - m.home : m.home;
      const [x, y] = P(gx, gy);
      this.towers.push({ x, y, d, h: near ? rng.range(10, 14) : rng.range(34, 52), w: near ? 22 : rng.range(16, 22), team, near });
    }
    this.towers.sort((p, q) => p.d - q.d);
    for (const t of this.towers) this.drawTower(g, t, rng, m);
  }

  drawTower(g, t, rng, m) {
    const team = this.teams[t.team];
    const w = t.w * 0.85;
    const bx = t.x, by = t.y, top = by - t.h * H;
    // Timber frame.
    g.fillStyle = m.time === 'night' ? '#1d160f' : '#4a3520';
    g.fillRect(bx - w / 2, top, w, by - top);
    // Drape in the club's colours, with a stripe and its crest on the tall towers.
    const dh = (by - top) * (t.near ? 0.7 : 0.62);
    g.fillStyle = team.robe;
    g.fillRect(bx - w / 2 + 0.6, top + 2, w - 1.2, dh);
    g.fillStyle = team.secondary;
    g.globalAlpha = 0.85;
    g.fillRect(bx - w / 2 + 0.6, top + 2 + dh * 0.82, w - 1.2, dh * 0.08);
    g.globalAlpha = 1;
    // Drape hem.
    g.fillStyle = team.dark;
    g.beginPath();
    for (let x = bx - w / 2 + 0.6; x < bx + w / 2 - 0.6; x += 2) {
      g.moveTo(x, top + 2 + dh);
      g.lineTo(x + 1, top + 4 + dh);
      g.lineTo(x + 2, top + 2 + dh);
    }
    g.fill();
    if (!t.near && w > 12) {
      const cs = Math.min(w * 0.55, dh * 0.5);
      this.drawCrest(g, team, bx - cs / 2, top + 2 + dh * 0.22, cs);
    }
    // Spectators along the top rail.
    const fill = m.crowd;
    for (let row = 0; row < 3; row++) {
      for (let x = bx - w / 2 + 1; x < bx + w / 2 - 0.5; x += 1.5) {
        if (!rng.chance(fill)) continue;
        const c = rng.chance(0.55) ? (rng.chance(0.75) ? team.robe : team.secondary) : rng.pick(CROWD);
        g.fillStyle = c;
        g.fillRect(x + rng.range(-0.2, 0.2), top - 1.6 + row * 1.2 - 2.2, 1.1, 1.6);
        g.fillStyle = rng.pick(['#f1c9a5', '#c68a5a', '#6e4630', '#e0ac7e']);
        g.beginPath();
        g.arc(x + 0.55, top - 2.6 + row * 1.2 - 2.2, 0.5, 0, TAU);
        g.fill();
      }
    }
    // Roof pennant on tall towers.
    if (!t.near) {
      g.strokeStyle = '#2b2118';
      g.lineWidth = 0.4;
      g.beginPath();
      g.moveTo(bx, top - 5);
      g.lineTo(bx, top - 14);
      g.stroke();
      g.fillStyle = team.color;
      g.beginPath();
      g.moveTo(bx, top - 14);
      g.lineTo(bx + 5, top - 12.5);
      g.lineTo(bx, top - 11);
      g.fill();
    }
    t.top = top - 4;
    t.w2 = w / 2;
  }

  // Ground-plane helpers for the stadium canvas, in world feet.
  quad(g, x0, y0, x1, y1) {
    g.beginPath();
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) g.lineTo(...P(x, y));
    g.closePath();
    g.fill();
  }

  line(g, x0, y0, x1, y1) {
    g.beginPath();
    g.moveTo(...P(x0, y0));
    g.lineTo(...P(x1, y1));
    g.stroke();
  }

  drawCrest(g, team, x, y, size) {
    g.save();
    g.translate(x, y);
    g.scale(size / 24, size / 24);
    g.beginPath();
    g.arc(12, 12, 11.5, 0, TAU);
    g.fillStyle = team.robe;
    g.fill();
    g.save();
    g.clip();
    g.fillStyle = team.secondary;
    for (const poly of CREST_SHAPES[team.crest.pattern]) {
      g.beginPath();
      poly.forEach(([u, v], i) => (i ? g.lineTo(u * 24, v * 24) : g.moveTo(u * 24, v * 24)));
      g.fill();
    }
    if (team.crest.pattern === 'ring') {
      g.strokeStyle = team.secondary;
      g.lineWidth = 2.4;
      g.beginPath();
      g.arc(12, 12, 9, 0, TAU);
      g.stroke();
    }
    g.restore();
    g.translate(5.4, 5.4);
    g.scale(0.55, 0.55);
    const p = new Path2D(GLYPHS[team.crest.glyph]);
    g.lineWidth = 1.4;
    g.strokeStyle = team.dark;
    g.stroke(p);
    g.fillStyle = team.secondary;
    g.fill(p, 'evenodd');
    g.restore();
  }

  // --- weather ----------------------------------------------------------------------

  makeWeather() {
    const w = this.state?.match.weather;
    this.weather = [];
    const n = w === 'rain' ? 260 : w === 'drizzle' ? 90 : w === 'snow' ? 170 : 0;
    for (let i = 0; i < n; i++) this.weather.push({ x: rand(0, this.w), y: rand(0, this.h), s: rand(0.5, 1), p: rand(0, TAU) });
  }

  // --- events and particles ---------------------------------------------------------

  ingest(events) {
    for (const e of events) {
      const [px, py] = P(e.x, e.y ?? 0, e.z ?? 0);
      switch (e.type) {
        case 'goal': {
          const t = this.teams[e.team];
          this.burst(px, py, 40, [t.light, t.secondary, '#ffffff'], 30, 'spark');
          for (const tw of this.towers) {
            if (tw.team !== e.team) continue;
            for (let i = 0; i < 6; i++) this.add({ type: 'confetti', x: tw.x + rand(-tw.w2, tw.w2), y: tw.top, vx: rand(-6, 6), vy: rand(-18, -6), g: 14, life: rand(1.2, 2.2), color: Math.random() < 0.6 ? t.color : t.secondary, size: rand(0.6, 1.1), spin: rand(0, TAU) });
          }
          this.flash = { text: 'GOAL', color: t.light, t: 1.8 };
          break;
        }
        case 'snitch': {
          this.flash = null;
          this.burst(px, py, 70, ['#ffe27a', '#fff6c8', '#f2b632'], 36, 'spark');
          for (const tw of this.towers) {
            for (let i = 0; i < 5; i++) this.add({ type: 'confetti', x: tw.x + rand(-tw.w2, tw.w2), y: tw.top, vx: rand(-6, 6), vy: rand(-20, -6), g: 14, life: rand(1.5, 2.8), color: Math.random() < 0.5 ? '#ffd34d' : this.teams[e.team].color, size: rand(0.6, 1.2), spin: rand(0, TAU) });
          }
          break;
        }
        case 'bat':
          this.burst(px, py, 6 + e.power * 6, ['#ffffff', '#ffe9b0'], 22, 'spark');
          this.add({ type: 'ring', x: px, y: py, life: 0.25, size: 2.5, color: 'rgba(255,255,255,0.8)' });
          break;
        case 'bonk':
          for (let i = 0; i < (e.ko ? 7 : 4); i++) this.add({ type: 'star', x: px, y: py - 2, vx: rand(-10, 10), vy: rand(-12, -2), g: 8, life: rand(0.6, 1), size: rand(0.8, 1.3), color: '#ffe066', spin: rand(0, TAU) });
          break;
        case 'save':
          this.burst(px, py, 10, ['#ffffff', '#d8e4ff'], 16, 'spark');
          break;
        case 'rim':
          this.burst(px, py, 12, ['#ffd780', '#ffffff'], 18, 'spark');
          break;
        case 'whistle':
          this.add({ type: 'ring', x: px, y: py, life: 0.6, size: 6, color: 'rgba(255,255,255,0.7)' });
          break;
        case 'crash':
          for (let i = 0; i < 14; i++) this.add({ type: 'puff', x: px + rand(-3, 3), y: py, vx: rand(-8, 8), vy: rand(-6, 0), g: 0, life: rand(0.6, 1.2), size: rand(1.5, 3), color: 'rgba(110,85,55,0.5)' });
          break;
        case 'spot':
          this.add({ type: 'ring', x: px, y: py, life: 0.5, size: 4, color: 'rgba(255,215,90,0.8)' });
          break;
        case 'near':
          this.burst(px, py, 8, ['#ffe27a', '#ffffff'], 14, 'spark');
          break;
      }
    }
    events.length = 0;
  }

  add(p) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    p.max = p.life;
    this.particles.push(p);
  }

  burst(x, y, n, colors, speed, type) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), v = rand(0.3, 1) * speed;
      this.add({ type, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.8, g: 10, life: rand(0.4, 1), size: rand(0.3, 0.7), color: colors[i % colors.length] });
    }
  }

  update(state, simDt, realDt) {
    this.fitCamera(state, realDt);
    this.tick = (this.tick ?? 0) + realDt;
    for (const p of this.particles) {
      p.life -= simDt;
      if (p.vx !== undefined) {
        p.vy += (p.g ?? 0) * simDt;
        p.x += p.vx * simDt;
        p.y += p.vy * simDt;
      }
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    if (this.flash) {
      this.flash.t -= realDt;
      if (this.flash.t <= 0) this.flash = null;
    }
    // Trails for the fast balls.
    if (simDt > 0) {
      const keep = (key, o, n) => {
        const tr = this.trails.get(key) ?? [];
        tr.push(P(o.x, o.y, o.z));
        if (tr.length > n) tr.shift();
        this.trails.set(key, tr);
      };
      for (const b of state.bludgers) keep(`b${b.id}`, b, 7);
      keep('s', state.snitch, 10);
      keep('q', state.quaffle, 6);
    }
    const wind = state.match.wind;
    for (const c of this.clouds) {
      c.x += wind.x * 0.5 * simDt + 2 * simDt;
      c.y += wind.y * 0.3 * simDt;
      if (c.x > 450) c.x = -450;
      if (c.y > 160) c.y = -160;
      if (c.y < -160) c.y = 160;
    }
    for (const f of this.weather) {
      const m = state.match.weather;
      if (m === 'snow') {
        f.y += (18 + 14 * f.s) * realDt;
        f.x += (Math.sin(this.tick + f.p) * 10 + wind.x) * realDt;
      } else {
        f.y += (520 + 300 * f.s) * realDt;
        f.x += (wind.x * 6 + 40) * realDt;
      }
      if (f.y > this.h) {
        f.y -= this.h + 10;
        f.x = rand(-40, this.w);
      }
      if (f.x > this.w + 20) f.x -= this.w + 40;
      if (f.x < -40) f.x += this.w + 40;
    }
  }

  // --- drawing --------------------------------------------------------------------------

  draw(state) {
    const ctx = this.ctx;
    const m = state.match;
    const { dpr } = this;
    const z = this.cam.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BACKDROP[m.time];
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (this.w / 2 - this.cam.x * z), dpr * (this.centerY - this.cam.y * z));
    ctx.drawImage(this.stadium, EXT.x0, EXT.y0, EXT.x1 - EXT.x0, EXT.y1 - EXT.y0);
    this.fz = Math.max(1.5, 3.4 / z); // figures are drawn larger than life so they read
    this.px = 1 / z; // one screen pixel in projected units

    // Cloud shadows drift over the pitch.
    for (const c of this.clouds) {
      const [cx, cy] = P(c.x, c.y);
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, c.r);
      grd.addColorStop(0, 'rgba(0,10,20,0.13)');
      grd.addColorStop(1, 'rgba(0,10,20,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(cx, cy, c.r, c.r * K, 0, 0, TAU);
      ctx.fill();
    }

    this.drawShadows(state);
    // Painter's order: far (low y) first.
    const items = [];
    const D = (o) => depth(o.x, o.y);
    for (const p of state.players) items.push([D(p), 0, p]);
    items.push([D(state.referee), 1, state.referee]);
    for (const s of [-1, 1]) HOOPS.forEach((h, i) => items.push([depth(s * HOOP_X, h.y), 2, { s, h, i }]));
    for (const b of state.bludgers) items.push([D(b), 3, b]);
    if (!state.quaffle.holder) items.push([D(state.quaffle), 4, state.quaffle]);
    items.push([D(state.snitch), 5, state.snitch]);
    items.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, kind, o] of items) {
      if (kind === 0) this.drawPlayer(state, o);
      else if (kind === 1) this.drawReferee(state, o);
      else if (kind === 2) this.drawHoop(o);
      else if (kind === 3) this.drawBludger(o);
      else if (kind === 4) this.drawQuaffle(o.x, o.y, o.z);
      else this.drawSnitch(state, o);
    }
    this.drawParticles();
    if (this.showNames) this.drawNames(state);

    // Screen-space: light, weather, vignette, flash.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawLight(state);
    this.drawWeather(state);
    this.drawVignette();
    if (this.flash) {
      const f = this.flash;
      const a = clamp(f.t / 0.5, 0, 1) * clamp((1.8 - f.t) / 0.15, 0, 1);
      const size = clamp(this.w / 9, 40, 110);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = `italic 700 ${size}px Georgia, 'Times New Roman', serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = size / 14;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      const y = this.centerY - this.viewH * 0.18 - (1.8 - f.t) * 10;
      ctx.strokeText(f.text, this.w / 2, y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, this.w / 2, y);
      ctx.restore();
    }
  }

  drawShadows(state) {
    const ctx = this.ctx;
    const f = this.fz;
    ctx.fillStyle = 'rgba(0,0,0,1)';
    const shadow = (x, y, z, r) => {
      const a = 0.28 * Math.max(0.15, 1 - z / 160);
      const rr = r * Math.max(0.5, 1 - z / 300);
      ctx.globalAlpha = a;
      const [sx, sy] = P(x, y);
      ctx.beginPath();
      ctx.ellipse(sx, sy, rr, rr * K, 0, 0, TAU);
      ctx.fill();
    };
    for (const p of state.players) {
      if (p.out && p.landed) continue;
      shadow(p.x, p.y, p.z, 2.6 * f);
    }
    shadow(state.referee.x, state.referee.y, state.referee.z, 2.6 * f);
    for (const b of state.bludgers) shadow(b.x, b.y, b.z, 1.1 * f);
    if (!state.quaffle.holder) shadow(state.quaffle.x, state.quaffle.y, state.quaffle.z, 1.1 * f);
    ctx.globalAlpha = 1;
  }

  // A rider on a broom, centred at the projected point.
  drawRider(x, y, z, heading, vz, look) {
    const ctx = this.ctx;
    const f = this.fz;
    const [px, py] = P(x, y, z);
    const hc = Math.cos(heading), hs = Math.sin(heading);
    const c = hc * CY - hs * SY, s = (hc * SY + hs * CY) * K;
    const l = Math.hypot(c, s) || 1;
    const ux = c / l, uy = s / l;
    const tilt = clamp(-vz / 70, -0.6, 0.6) * 2.4 * f; // nose down when diving
    ctx.save();
    ctx.translate(px, py);
    if (look.spin) ctx.rotate(look.spin);
    if (look.roll) ctx.scale(1, Math.cos(look.roll * Math.PI));
    // Broom: handle, then bristles at the tail.
    const hx = ux * 3.6 * f, hy = uy * 3.6 * f + tilt;
    const tx = -ux * 3.2 * f, ty = -uy * 3.2 * f - tilt;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#6d4b2a';
    ctx.lineWidth = 0.45 * f;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    const nx = -uy, ny = ux;
    ctx.fillStyle = '#c7a35a';
    ctx.beginPath();
    ctx.moveTo(tx + ux * 0.4 * f, ty + uy * 0.4 * f);
    ctx.lineTo(tx - ux * 2 * f + nx * 0.9 * f, ty - uy * 2 * f + ny * 0.9 * f);
    ctx.lineTo(tx - ux * 2.2 * f - nx * 0.9 * f, ty - uy * 2.2 * f - ny * 0.9 * f);
    ctx.closePath();
    ctx.fill();
    // Cloak streaming behind.
    const flap = Math.sin((this.tick ?? 0) * 12 + x) * 0.4 * f;
    ctx.fillStyle = look.dark;
    ctx.beginPath();
    ctx.moveTo(-ux * 0.2 * f, -1.9 * f);
    ctx.lineTo(-ux * 3 * f + nx * flap, -uy * 3 * f - 0.9 * f + ny * flap);
    ctx.lineTo(-ux * 2.4 * f, -uy * 2.4 * f - 0.1 * f);
    ctx.closePath();
    ctx.fill();
    // Body and trim.
    ctx.fillStyle = look.robe;
    ctx.beginPath();
    ctx.ellipse(-ux * 0.3 * f, -1.3 * f, 1.05 * f, 1.35 * f, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = look.trim;
    ctx.lineWidth = 0.28 * f;
    ctx.beginPath();
    ctx.moveTo(-ux * 0.3 * f - 0.95 * f, -1.0 * f);
    ctx.lineTo(-ux * 0.3 * f + 0.95 * f, -1.0 * f);
    ctx.stroke();
    // Head.
    const hxh = ux * 0.25 * f, hyh = -3 * f;
    ctx.fillStyle = look.skin;
    ctx.beginPath();
    ctx.arc(hxh, hyh, 0.72 * f, 0, TAU);
    ctx.fill();
    ctx.fillStyle = look.hair;
    ctx.beginPath();
    ctx.arc(hxh - ux * 0.15 * f, hyh - 0.1 * f, 0.74 * f, Math.PI * 1.05, Math.PI * 1.95);
    ctx.fill();
    if (look.band) {
      ctx.strokeStyle = look.band;
      ctx.lineWidth = 0.25 * f;
      ctx.beginPath();
      ctx.moveTo(hxh - 0.7 * f, hyh - 0.15 * f);
      ctx.lineTo(hxh + 0.7 * f, hyh - 0.15 * f);
      ctx.stroke();
    }
    if (look.bat !== undefined) {
      // A Beater's bat, swung through an arc when they strike.
      const a = Math.atan2(uy, ux) - 0.9 + look.bat * 2.2;
      ctx.strokeStyle = '#8a6239';
      ctx.lineWidth = 0.55 * f;
      ctx.beginPath();
      ctx.moveTo(nx * 0.9 * f, -1.8 * f);
      ctx.lineTo(nx * 0.9 * f + Math.cos(a) * 2.6 * f, -1.8 * f + Math.sin(a) * 2.6 * f * 0.7);
      ctx.stroke();
    }
    if (look.gloves) {
      ctx.fillStyle = look.gloves;
      ctx.beginPath();
      ctx.arc(nx * 1.1 * f, -1.9 * f, 0.38 * f, 0, TAU);
      ctx.arc(-nx * 1.1 * f, -1.9 * f, 0.38 * f, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawPlayer(state, p) {
    const t = this.teams[p.team];
    if (p.out && p.landed) {
      // Down on the grass.
      const ctx = this.ctx;
      const f = this.fz;
      ctx.save();
      ctx.translate(...P(p.x, p.y));
      ctx.strokeStyle = '#6d4b2a';
      ctx.lineWidth = 0.4 * f;
      ctx.beginPath();
      ctx.moveTo(-3 * f, 0.6 * f);
      ctx.lineTo(3.2 * f, -0.4 * f);
      ctx.stroke();
      ctx.fillStyle = t.robe;
      ctx.beginPath();
      ctx.ellipse(0.4 * f, -0.2 * f, 1.6 * f, 0.7 * f, -0.2, 0, TAU);
      ctx.fill();
      ctx.fillStyle = p.skin;
      ctx.beginPath();
      ctx.arc(2.3 * f, -0.5 * f, 0.6 * f, 0, TAU);
      ctx.fill();
      ctx.restore();
      return;
    }
    const tick = this.tick ?? 0;
    this.drawRider(p.x, p.y, p.z, p.heading, p.vz, {
      robe: t.robe,
      dark: t.dark,
      trim: t.secondary,
      skin: p.skin,
      hair: p.hair,
      band: p.role === 'seeker' ? '#ffd34d' : p.captain ? t.secondary : null,
      bat: p.role === 'beater' ? p.swing : undefined,
      gloves: p.role === 'keeper' ? t.secondary : null,
      spin: p.out || p.stun > 0 ? tick * 7 : 0,
      roll: p.roll,
    });
    if (state.quaffle.holder === p) {
      const q = state.quaffle;
      this.drawQuaffle(q.x, q.y, q.z);
    }
    if (state.snitch.holder === p) this.drawSnitch(state, state.snitch);
  }

  drawReferee(state, r) {
    const hd = Math.atan2(r.vy, r.vx || 0.001);
    this.drawRider(r.x, r.y, r.z, Math.hypot(r.vx, r.vy) > 3 ? hd : 0, r.vz, {
      robe: '#2a2a2e', dark: '#141416', trim: '#e8e8e8', skin: '#e0ac7e', hair: '#bdbdbd', band: null,
    });
  }

  drawHoop({ s, h }) {
    const ctx = this.ctx;
    const f = Math.min(this.fz, 1.8);
    const x = s * HOOP_X;
    const [bx, by] = P(x, h.y, 0);
    const [tx, ty] = P(x, h.y, h.z - HOOP_R);
    // The ring stands in the y–z plane, facing down the pitch.
    const ring = new Path2D();
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * TAU;
      const [rx, ry] = P(x, h.y + Math.cos(a) * HOOP_R, h.z + Math.sin(a) * HOOP_R);
      if (i) ring.lineTo(rx, ry);
      else ring.moveTo(rx, ry);
    }
    for (const [color, wd] of [['#7d5f26', 1], ['#e9c463', 0.55]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = wd * f;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.stroke(ring);
    }
  }

  drawTrail(key, color, width) {
    const tr = this.trails.get(key);
    if (!tr || tr.length < 2) return;
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    for (let i = 1; i < tr.length; i++) {
      const [x0, y0] = tr[i - 1], [x1, y1] = tr[i];
      if (Math.hypot(x1 - x0, y1 - y0) > 40) continue;
      ctx.globalAlpha = (i / tr.length) * 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = width * (i / tr.length);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawBludger(b) {
    const ctx = this.ctx;
    const r = Math.max(0.7 * this.fz, 3 * this.px);
    const [x, y] = P(b.x, b.y, b.z);
    if (Math.hypot(b.vx, b.vy, b.vz) > 50) this.drawTrail(`b${b.id}`, 'rgba(40,40,40,0.9)', r * 1.4);
    ctx.fillStyle = '#1c1c1e';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.35, 0, TAU);
    ctx.fill();
  }

  drawQuaffle(x0, y0, z0) {
    const ctx = this.ctx;
    const r = Math.max(0.8 * this.fz, 3.4 * this.px);
    const [x, y] = P(x0, y0, z0);
    ctx.fillStyle = '#a3261c';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,10,5,0.8)';
    ctx.lineWidth = r * 0.22;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,200,180,0.45)';
    ctx.beginPath();
    ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.32, 0, TAU);
    ctx.fill();
  }

  drawSnitch(state, s) {
    if (!s.released && !s.holder) return;
    const ctx = this.ctx;
    const r = Math.max(0.45 * this.fz, 1.7 * this.px);
    const [x, y] = P(s.x, s.y, s.z);
    const chased = state.players.some((p) => p.role === 'seeker' && p.mode === 'chase');
    if (!s.holder && Math.hypot(s.vx, s.vy, s.vz) > 30) this.drawTrail('s', 'rgba(255,214,90,0.8)', r * 0.9);
    // A glint that catches the eye when it hovers or is being chased.
    const glint = s.holder ? 1 : chased || s.mode === 'hover' ? 0.8 : 0.35 + 0.25 * Math.sin((this.tick ?? 0) * 3);
    const gr = r * 5;
    const grd = ctx.createRadialGradient(x, y, 0, x, y, gr);
    grd.addColorStop(0, `rgba(255,220,110,${0.55 * glint})`);
    grd.addColorStop(1, 'rgba(255,220,110,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, gr, 0, TAU);
    ctx.fill();
    const flap = Math.abs(Math.sin((this.tick ?? 0) * 40)) * r * 1.6;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.ellipse(x - r * 1.5, y - flap * 0.3, r * 1.4, Math.max(r * 0.25, flap * 0.5), -0.3, 0, TAU);
    ctx.ellipse(x + r * 1.5, y - flap * 0.3, r * 1.4, Math.max(r * 0.25, flap * 0.5), 0.3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#ffcf3d';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fff3b8';
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, TAU);
    ctx.fill();
  }

  drawNames(state) {
    const ctx = this.ctx;
    const px = this.px;
    const size = 10.5 * px;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 2.6 * px;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    const q = state.quaffle;
    for (const p of state.players) {
      if (p.out && p.landed) continue;
      // Always label the ball carrier and chasing Seekers; others only when close in.
      const key = q.holder === p || (p.role === 'seeker' && p.mode === 'chase');
      if (!key && this.cam.zoom < 3.2) continue;
      const t = this.teams[p.team];
      const [x, py] = P(p.x, p.y, p.z);
      const y = py - 4.4 * this.fz;
      const label = `${p.number} ${p.surname}`;
      ctx.globalAlpha = key ? 1 : 0.75;
      ctx.strokeText(label, x, y);
      ctx.fillStyle = t.light;
      ctx.fillText(label, x, y);
    }
    ctx.globalAlpha = 1;
  }

  drawParticles() {
    const ctx = this.ctx;
    for (const p of this.particles) {
      const a = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = a;
      if (p.type === 'ring') {
        const r = p.size * (1 + (1 - a) * 2);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 0.4 * this.fz;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r, r * 0.8, 0, 0, TAU);
        ctx.stroke();
      } else if (p.type === 'confetti') {
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin + p.life * 8);
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      } else if (p.type === 'star') {
        ctx.fillStyle = p.color;
        const r = p.size * this.fz * 0.6;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin + p.life * 6);
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const rr = i % 2 ? r * 0.4 : r;
          const an = (i / 10) * TAU;
          if (i) ctx.lineTo(Math.cos(an) * rr, Math.sin(an) * rr);
          else ctx.moveTo(rr, 0);
        }
        ctx.fill();
        ctx.restore();
      } else if (p.type === 'puff') {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1.5 - a * 0.5), 0, TAU);
        ctx.fill();
      } else {
        ctx.fillStyle = p.color;
        const r = Math.max(p.size, 1.2 * this.px);
        ctx.fillRect(p.x - r / 2, p.y - r / 2, r, r);
      }
    }
    ctx.globalAlpha = 1;
  }

  drawLight(state) {
    const ctx = this.ctx;
    const m = state.match;
    if (m.time === 'evening') {
      ctx.fillStyle = 'rgba(255,120,40,0.12)';
      ctx.fillRect(0, 0, this.w, this.h);
    } else if (m.time === 'night') {
      ctx.fillStyle = 'rgba(6,12,34,0.38)';
      ctx.fillRect(0, 0, this.w, this.h);
      // Floating lanterns light the pitch from above.
      ctx.globalCompositeOperation = 'lighter';
      const z = this.cam.zoom;
      for (const [lx, ly] of [[-160, -60], [0, -70], [160, -60], [-160, 60], [160, 60]]) {
        const { sx, sy } = this.project(lx, ly, 0);
        const r = 170 * z;
        const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
        grd.addColorStop(0, 'rgba(255,230,170,0.09)');
        grd.addColorStop(1, 'rgba(255,230,170,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    if (m.weather === 'overcast' || m.weather === 'rain' || m.weather === 'drizzle') {
      ctx.fillStyle = 'rgba(110,120,135,0.14)';
      ctx.fillRect(0, 0, this.w, this.h);
    } else if (m.weather === 'sunny') {
      ctx.fillStyle = 'rgba(255,240,200,0.05)';
      ctx.fillRect(0, 0, this.w, this.h);
    } else if (m.weather === 'fog') {
      const grd = ctx.createRadialGradient(this.w / 2, this.centerY, Math.min(this.w, this.h) * 0.15, this.w / 2, this.centerY, Math.max(this.w, this.h) * 0.7);
      grd.addColorStop(0, 'rgba(210,215,220,0.12)');
      grd.addColorStop(1, 'rgba(210,215,220,0.55)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }

  drawWeather(state) {
    const ctx = this.ctx;
    const m = state.match.weather;
    if (!this.weather.length) return;
    if (m === 'snow') {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (const f of this.weather) {
        ctx.beginPath();
        ctx.arc(f.x, f.y, 1 + f.s * 1.6, 0, TAU);
        ctx.fill();
      }
      return;
    }
    const wind = state.match.wind.x;
    ctx.strokeStyle = m === 'rain' ? 'rgba(200,215,235,0.35)' : 'rgba(200,215,235,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of this.weather) {
      const len = 10 + 12 * f.s;
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(f.x - (wind * 0.4 + 3), f.y - len);
    }
    ctx.stroke();
  }

  drawVignette() {
    const ctx = this.ctx;
    if (!this.vignette) {
      const g = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.35, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.45)');
      this.vignette = g;
    }
    ctx.fillStyle = this.vignette;
    ctx.fillRect(0, 0, this.w, this.h);
  }
}
