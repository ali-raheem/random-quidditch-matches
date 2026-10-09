// Match simulation: flight, the four balls' behaviour, every role's AI and the rules.
// Deterministic for a given seed and fixed timestep, and free of DOM access so it
// runs under node:test.
//
// The sim pushes cosmetic events (throws, bat strikes, whistles) onto state.events
// and commentary onto state.log. It never reads anything back from presentation.

import { createRng } from './rng.js';
import { generateMatch, TACTICS } from './gen.js';
import { HOOP_X, HOOP_R, HOOPS, SCORING_X, PENALTY_X, CEILING, FLOOR, inside, edgePoint } from './pitch.js';

export const MAX_TIME = 900; // past this the captains agree to end it
export const GOAL_POINTS = 10;
export const SNITCH_POINTS = 150;
const G_Q = 12; // the Quaffle is bewitched to fall slowly
const BLUDGER_SPEED = 62;
const BLUDGER_ACCEL = 70;
const SNITCH_MAX = 104;
const SNITCH_ACCEL = 320;
const HIT_REACH = 5.5; // a Beater's bat
const BONK_R = 2.8; // a Bludger this close has hit you
const SPOT_RATE = 0.016; // per Seeker look (every ~0.2 s): base chance to see a showing Snitch
const KO_BASE = 0.003;

// Fouls from Quidditch's official list, with what the referee is penalising.
export const FOULS = {
  blagging: 'seizing an opponent’s broom tail',
  blatching: 'flying to collide',
  blurting: 'locking broom handles to steer an opponent off course',
  bumphing: 'hitting a Bludger towards the crowd',
  cobbing: 'excessive use of the elbows',
  flacking: 'reaching through the hoop to punch the Quaffle out',
  haversacking: 'keeping a hand on the Quaffle as it went through the hoop',
  quafflepocking: 'tampering with the Quaffle',
  snitchnip: 'touching the Snitch when not the Seeker',
  stooging: 'more than one Chaser in the scoring area',
};
export const FOUL_NAMES = {
  blagging: 'Blagging', blatching: 'Blatching', blurting: 'Blurting', bumphing: 'Bumphing', cobbing: 'Cobbing',
  flacking: 'Flacking', haversacking: 'Haversacking', quafflepocking: 'Quaffle-pocking', snitchnip: 'Snitchnip', stooging: 'Stooging',
};
const HOOP_NAMES = ['left', 'centre', 'right'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const active = (p) => !p.out && p.stun <= 0;
const handles = (p) => p.role === 'chaser' || p.role === 'keeper';

export function createMatch(seed) {
  const match = generateMatch(seed);
  const rng = createRng((seed ^ 0x9e3779b9) >>> 0);
  // Commentary phrasing has its own stream so wording never shifts the play.
  const crng = createRng((seed ^ 0x5bd1e995) >>> 0);
  const teams = match.teams.map((t) => ({ ...t, dir: -t.side, score: 0, fouls: 0, timeoutUsed: false }));
  const players = [];
  for (const t of teams) {
    const s = t.side;
    const tac = TACTICS[t.tactic];
    let chaser = 0, beater = 0;
    for (const g of t.players) {
      const k = g.role;
      let hx = 0, hy = 0;
      if (k === 'keeper') hx = s * 190;
      else if (k === 'chaser') { hx = s * 40; hy = (chaser++ - 1) * 34; }
      else if (k === 'beater') { hx = s * 80; hy = beater++ ? 52 : -52; }
      else { hx = s * 115; hy = -s * 62; }
      const sk = g.skill;
      const p = {
        id: players.length,
        team: t.index,
        role: k,
        name: g.name,
        surname: g.surname,
        number: g.number,
        captain: !!g.captain,
        skill: sk,
        skin: g.skin,
        hair: g.hair,
        maxSpeed: t.broom.speed * (0.82 + 0.3 * sk.speed) * (k === 'seeker' ? 1.06 : k === 'keeper' ? 0.92 : 1),
        accel: t.broom.accel * (0.75 + 0.45 * sk.agility) * (0.85 + 0.3 * t.broom.handling),
        x: hx, y: hy, z: 0, vx: 0, vy: 0, vz: 0,
        home: { x: hx, y: hy },
        heading: t.dir > 0 ? 0 : Math.PI,
        gx: hx, gy: hy, gz: 22, urgency: 0.4, boost: 1, low: false,
        stun: 0, out: false, landed: false, think: rng.range(0, 0.2), cd: 0, hitCd: 0,
        mode: k === 'seeker' ? 'search' : 'play',
        duty: k !== 'beater' ? null : beater === 1 ? 'hunt' : tac.screen ? 'screen' : rng.chance(tac.hunt) ? 'hunt' : 'guard',
        patrol: rng.range(0, Math.PI * 2),
        reactAt: null, glide: 0, holdAt: 0, chaseAt: 0, blindUntil: 40, brake: true, grabAt: 0, shimmyUntil: 0, lost: 0, lapse: false,
        dodgeAt: [0, 0], immune: [0, 0], roll: 0, swing: 0,
        stats: { goals: 0, shots: 0, saves: 0, passes: 0, hits: 0, fouls: 0 },
      };
      players.push(p);
    }
  }
  const bludgers = [0, 1].map((id) => ({
    id, x: id ? 3 : -3, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    mode: 'crate', target: null, retarget: 0, struckT: 0, cd: 0, lastBy: null, lastAt: -9,
  }));
  return {
    seed,
    rng,
    crng,
    match,
    time: 0,
    phase: 'lineup',
    phaseT: 0,
    teams,
    players,
    quaffle: {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, holder: null, flight: 'ref', team: null, thrower: null,
      receiver: null, restartTeam: null, toKeeper: false, deadT: 0, tried: new Array(players.length).fill(-9),
      haversack: false, pocked: false, penalty: false, hoop: 1,
    },
    bludgers,
    snitch: {
      x: 0, y: 0, z: 1, vx: 0, vy: 0, vz: 0, released: false, mode: 'crate', t: 0,
      tx: 0, ty: 0, tz: 0, speed: 0, energy: 1, jinkT: 0, holder: null,
    },
    referee: { name: match.referee, x: 0, y: -30, z: 0, vx: 0, vy: 0, vz: 0 },
    penalty: null,
    events: [],
    log: [],
    over: false,
    winner: null,
    endT: 0,
    endReason: null,
    catcher: null,
    noSeekersT: 0,
    stooge: 0,
  };
}

export const teamPlayers = (state, team) => state.players.filter((p) => p.team === team);
const opponents = (state, p) => state.players.filter((o) => o.team !== p.team);

export function teamStats(state) {
  return state.teams.map((team) => {
    const mine = teamPlayers(state, team.index);
    return { team, score: team.score, on: mine.filter((p) => !p.out).length, fouls: team.fouls };
  });
}

// --- commentary -----------------------------------------------------------------------

// Parts are strings, players or teams; the HUD colours players and teams.
function say(state, kind, team, ...parts) {
  state.log.push({ t: state.time, kind, team, parts });
}
const pick = (state, arr) => state.crng.pick(arr);

// --- the match clock and phases -------------------------------------------------------

export function step(state, dt) {
  if (state.over) {
    settle(state, dt);
    return;
  }
  state.time += dt;
  state.phaseT += dt;
  phases(state);
  updateSnitch(state, dt);
  for (const p of state.players) {
    p.think -= dt;
    p.cd -= dt;
    p.hitCd -= dt;
    p.roll = Math.max(0, p.roll - dt * 1.6);
    p.swing = Math.max(0, p.swing - dt * 4);
    if (p.think <= 0 && active(p)) {
      think(state, p);
      p.think = 0.15 + state.rng.next() * 0.1;
    }
  }
  for (const p of state.players) move(state, p, dt);
  separate(state);
  keeperReact(state);
  updateQuaffle(state, dt);
  updateBludgers(state, dt);
  updateReferee(state, dt);
  rules(state, dt);
}

function phases(state) {
  const q = state.quaffle;
  if (state.phase === 'lineup' && state.phaseT > 2.5) {
    setPhase(state, 'release');
    whistle(state);
    const s = state.snitch;
    s.released = true;
    s.mode = 'dart';
    s.vz = 70;
    newDart(state, s);
    for (const b of state.bludgers) {
      b.mode = 'roam';
      b.vz = 55;
      b.vx = b.id ? 18 : -18;
      b.retarget = 1.2;
    }
    say(state, 'start', null, 'The Snitch and the Bludgers are released');
  } else if (state.phase === 'release' && state.phaseT > 1.6) {
    setPhase(state, 'play');
    whistle(state);
    Object.assign(q, { x: 0, y: 0, z: 34, vx: 0, vy: 0, vz: 22, flight: 'loose', holder: null, team: null });
    say(state, 'start', null, `${state.referee.name} throws the Quaffle up. The match is on!`);
  } else if (state.phase === 'timeout' && state.phaseT > 7) {
    setPhase(state, 'play');
    whistle(state);
    say(state, 'timeout', null, 'Time-out over. Play resumes');
  } else if (state.phase === 'penalty') {
    const pen = state.penalty;
    if (!pen.taker || !active(pen.taker)) {
      pen.taker = penaltyTaker(state, pen.team);
      if (!pen.taker) {
        setPhase(state, 'play');
        return;
      }
      if (q.holder !== pen.taker) feed(state, pen.taker);
    }
  }
}

function setPhase(state, phase) {
  state.phase = phase;
  state.phaseT = 0;
}

function whistle(state) {
  const r = state.referee;
  state.events.push({ type: 'whistle', x: r.x, y: r.y, z: r.z });
}

function rules(state, dt) {
  // No substitutions: if both Seekers are out nobody can end it, so the captains agree to.
  const seekers = state.players.filter((p) => p.role === 'seeker' && !p.out);
  state.noSeekersT = seekers.length ? 0 : state.noSeekersT + dt;
  if (state.noSeekersT > 25) {
    endMatch(state, 'consent', 'With both Seekers out, the captains agree to end the match');
    return;
  }
  if (state.time >= MAX_TIME) {
    endMatch(state, 'consent', 'The captains agree to end the match');
    return;
  }
  // Stooging: only one attacking Chaser may be in the scoring area at a time. A moment's
  // overlap is let go; hanging about in there isn't.
  const q = state.quaffle;
  const h = q.holder;
  const t = h && state.teams[h.team];
  const other = state.phase === 'play' && h?.role === 'chaser' && t.dir * h.x > SCORING_X &&
    state.players.find((p) => p !== h && p.team === h.team && p.role === 'chaser' && !p.out && t.dir * p.x > SCORING_X);
  state.stooge = other ? state.stooge + dt : 0;
  if (other && state.stooge > 0.8 && refSees(state, other, 0.2)) callFoul(state, other, 'stooging', 1 - h.team);
}

function endMatch(state, reason, text) {
  state.over = true;
  state.endT = state.time;
  state.endReason = reason;
  const [a, b] = state.teams;
  state.winner = a.score === b.score ? null : a.score > b.score ? a : b;
  whistle(state);
  if (text) say(state, 'end', null, text);
}

// After the final whistle everyone glides to a hover.
function settle(state, dt) {
  const k = Math.exp(-dt * 1.5);
  for (const o of [...state.players, ...state.bludgers]) {
    o.vx *= k;
    o.vy *= k;
    o.vz *= k;
    o.x += o.vx * dt;
    o.y += o.vy * dt;
    o.z = Math.max(o.out ? 0 : 1, o.z + o.vz * dt);
  }
  const s = state.snitch;
  if (s.holder) Object.assign(s, { x: s.holder.x, y: s.holder.y, z: s.holder.z + 4 });
}

// --- flight ---------------------------------------------------------------------------

function move(state, p, dt) {
  if (p.out) {
    // Out of the match: drifts down to the grass and stays there.
    if (p.z > 0) {
      p.vz = Math.max(-22, p.vz - 18 * dt);
      p.vx *= Math.exp(-dt * 1.2);
      p.vy *= Math.exp(-dt * 1.2);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z = Math.max(0, p.z + p.vz * dt);
    } else {
      p.vx = p.vy = p.vz = 0;
      p.landed = true;
    }
    return;
  }
  if (p.stun > 0) {
    p.stun -= dt;
    const k = Math.exp(-dt * 1.4);
    p.vx *= k;
    p.vy *= k;
    p.vz = p.vz * k - 9 * dt;
  } else if (p.glide > 0) {
    // A committed dive: no steering until it's done.
    p.glide -= dt;
  } else {
    const dx = p.gx - p.x, dy = p.gy - p.y, dz = p.gz - p.z;
    const d = Math.hypot(dx, dy, dz);
    let speed = p.maxSpeed * p.urgency * p.boost;
    if (state.quaffle.holder === p) speed *= 0.93;
    const want = d > 0.01 ? (p.brake ? Math.min(speed, d * 2) : speed) / d : 0;
    let ax = dx * want - p.vx, ay = dy * want - p.vy, az = dz * want - p.vz;
    const a = Math.hypot(ax, ay, az), lim = p.accel * p.boost * dt;
    if (a > lim) {
      ax *= lim / a;
      ay *= lim / a;
      az *= lim / a;
    }
    p.vx += ax;
    p.vy += ay;
    p.vz += az;
  }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.z += p.vz * dt;
  const floor = p.low ? 1.2 : FLOOR;
  if (p.z < floor) {
    p.z = floor;
    if (p.vz < 0) p.vz = 0;
  }
  if (p.z > CEILING) {
    p.z = CEILING;
    if (p.vz > 0) p.vz = 0;
  }
  // Players must not leave the pitch boundary.
  if (!inside(p.x, p.y, -4)) {
    const [ex, ey] = edgePoint(Math.atan2(p.y, p.x), -4);
    p.x = ex;
    p.y = ey;
    const r = Math.hypot(ex, ey) || 1;
    const out = (p.vx * ex + p.vy * ey) / r;
    if (out > 0) {
      p.vx -= (out * ex) / r;
      p.vy -= (out * ey) / r;
    }
  }
  const hs = Math.hypot(p.vx, p.vy);
  if (hs > 4) {
    let da = Math.atan2(p.vy, p.vx) - p.heading;
    da = ((da + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    p.heading += da * Math.min(1, dt * 6);
  }
}

function separate(state) {
  const ps = state.players;
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    if (a.out) continue;
    for (let j = i + 1; j < ps.length; j++) {
      const b = ps[j];
      if (b.out) continue;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 16 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2), push = (4 - d) * 0.25;
      a.x -= (dx / d) * push;
      a.y -= (dy / d) * push;
      a.z -= (dz / d) * push;
      b.x += (dx / d) * push;
      b.y += (dy / d) * push;
      b.z += (dz / d) * push;
    }
  }
}

function goTo(p, x, y, z, urgency = 1) {
  p.gx = x;
  p.gy = y;
  p.gz = clamp(z, p.low ? 1.2 : FLOOR, CEILING);
  p.urgency = urgency;
}

// Where something moving under the Quaffle's gentle gravity will be in t seconds.
function ballAt(q, t) {
  return {
    x: q.x + q.vx * t,
    y: q.y + q.vy * t,
    z: Math.max(0.6, q.z + q.vz * t - (q.flight === 'shot' || q.flight === 'pass' || q.flight === 'loose' ? 0.5 * G_Q * t * t : 0)),
  };
}

// Fly to the earliest point on the Quaffle's path that can be reached in time.
function chaseBall(state, p, urgency = 1) {
  const q = state.quaffle;
  let b = ballAt(q, 2.5);
  for (let t = 0.1; t <= 2.5; t += 0.1) {
    const c = ballAt(q, t);
    if (Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) <= p.maxSpeed * 0.85 * t) {
      b = c;
      break;
    }
  }
  p.low = b.z < FLOOR + 1;
  goTo(p, b.x, b.y, b.z, urgency);
}

// --- decisions ------------------------------------------------------------------------

function think(state, p) {
  p.boost = 1;
  p.low = false;
  p.brake = true;
  if (state.phase === 'lineup' || state.phase === 'release') {
    goTo(p, p.home.x, p.home.y, 22 + (p.role === 'seeker' ? 20 : 0), 0.35);
    return;
  }
  if (state.phase === 'timeout') {
    const t = state.teams[p.team];
    goTo(p, t.side * 120 + (p.id % 3) * 10 * t.side, ((p.id % 7) - 3) * 12, 18, 0.5);
    return;
  }
  switch (p.role) {
    case 'keeper': return thinkKeeper(state, p);
    case 'chaser': return thinkChaser(state, p);
    case 'beater': return thinkBeater(state, p);
    default: return thinkSeeker(state, p);
  }
}

function possession(state) {
  const q = state.quaffle;
  if (q.holder) return q.holder.team;
  if (q.flight === 'pass') return q.team;
  if (q.flight === 'feed' || q.flight === 'dead') return q.restartTeam;
  return null;
}

function nearestOpponent(state, p, roles = handles) {
  let best = null, bd = Infinity;
  for (const o of state.players) {
    if (o.team === p.team || !active(o) || !roles(o)) continue;
    const d = dist(o, p);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return { o: best, d: bd };
}

// Chasers --------------------------------------------------------------------------

function thinkChaser(state, p) {
  const q = state.quaffle;
  if (state.phase === 'penalty') return penaltyChaser(state, p);
  if (q.holder === p) return holderThink(state, p);
  if (q.flight === 'feed' || q.flight === 'dead' || q.flight === 'ref') return shape(state, p, q.restartTeam === p.team);
  const pos = possession(state);
  if (pos === null) {
    // A loose ball (or a shot in flight): the two nearest from each side go for it.
    const d = dist(p, q);
    const closer = state.players.filter((o) => o.team === p.team && o.role === 'chaser' && active(o) && dist(o, q) < d).length;
    if (closer < 2 && (q.flight !== 'shot' || closer < 1)) chaseBall(state, p);
    else shape(state, p, false);
    return;
  }
  if (q.flight === 'pass' && q.receiver === p) return chaseBall(state, p);
  if (pos === p.team) support(state, p);
  else defend(state, p);
}

// Formation shape when nobody has the ball yet.
function shape(state, p, attacking) {
  const t = state.teams[p.team];
  const k = (p.id % 3) - 1;
  const x = attacking ? t.dir * 30 : -t.dir * 40;
  goTo(p, x + k * 8, k * 36, 32 + k * 6, 0.7);
}

function support(state, p) {
  const q = state.quaffle;
  const t = state.teams[p.team];
  const tac = TACTICS[t.tactic];
  const h = q.holder ?? q.receiver;
  if (!h) return shape(state, p, true);
  const mates = state.players.filter((o) => o.team === p.team && o.role === 'chaser' && o !== h && !o.out);
  const k = mates.indexOf(p);
  const dir = t.dir;
  if (tac.sitBack && k === mates.length - 1 && mates.length >= 2) {
    goTo(p, t.side * 110, h.y * 0.3, 40, 0.8);
    return;
  }
  let gx, gy, gz;
  if (tac.arrowhead) {
    gx = h.x - dir * 14;
    gy = h.y + (k ? 18 : -18);
    gz = h.z + (k ? 5 : -5);
  } else {
    gx = h.x + dir * (26 + 12 * k);
    gy = (k ? 1 : -1) * 36 + h.y * 0.25;
    gz = 26 + 18 * k;
  }
  // Keep out of the scoring area while a teammate is in it, unless discipline slips.
  p.lapse = state.rng.chance((1.1 - p.skill.discipline) * 0.02 * tac.aggression);
  const limit = SCORING_X - 12;
  if (dir * gx > limit && !p.lapse) gx = dir * limit;
  if (dir * gx > HOOP_X - 20) gx = dir * (HOOP_X - 20);
  goTo(p, gx, clamp(gy, -70, 70), gz, 0.9);
}

function defend(state, p) {
  const q = state.quaffle;
  const t = state.teams[p.team];
  const tac = TACTICS[t.tactic];
  const h = q.holder ?? q.receiver;
  if (!h) return shape(state, p, false);
  if (q.flight === 'pass') {
    // The nearest defender tries to cut the pass out.
    const d = dist(p, q);
    const closer = state.players.filter((o) => o.team === p.team && o.role === 'chaser' && active(o) && dist(o, q) < d).length;
    if (closer === 0) return chaseBall(state, p);
  }
  const defenders = state.players
    .filter((o) => o.team === p.team && o.role === 'chaser' && active(o))
    .map((o) => [o, dist(o, h)])
    .sort((a, b) => a[1] - b[1] || a[0].id - b[0].id)
    .map(([o]) => o);
  const i = defenders.indexOf(p);
  if (tac.sitBack && i === defenders.length - 1 && defenders.length >= 2) {
    goTo(p, t.side * (SCORING_X - 8), h.y * 0.4, 40, 0.9);
    return;
  }
  const d = dist(p, h);
  if (i === 0 || (i === 1 && d < 14)) {
    goTo(p, h.x + h.vx * 0.25, h.y + h.vy * 0.25, h.z + h.vz * 0.25, 1);
    if (d < 4.5 && p.cd <= 0 && q.holder === h) tackle(state, p, h);
    return;
  }
  // Mark a Chaser who might receive, goal side of them.
  const attackers = state.players.filter((o) => o.team !== p.team && o.role === 'chaser' && o !== h && !o.out);
  const m = attackers[(i - 1) % Math.max(1, attackers.length)] ?? h;
  const hx = t.side * HOOP_X;
  const ux = hx - m.x, uy = -m.y, uz = 45 - m.z;
  const ul = Math.hypot(ux, uy, uz) || 1;
  goTo(p, m.x + (ux / ul) * 9, m.y + (uy / ul) * 9, m.z + (uz / ul) * 9, 0.9);
}

function tackle(state, p, h) {
  const rng = state.rng;
  const q = state.quaffle;
  const tac = TACTICS[state.teams[p.team].tactic];
  p.cd = 1.1;
  let chance = 0.17 + 0.3 * p.skill.power - 0.18 * h.skill.catching;
  if (rng.chance(0.035 * tac.aggression * (1.25 - p.skill.discipline))) {
    const type = rng.weighted([['cobbing', 3], ['blagging', 2], ['blatching', 2], ['blurting', 1]]);
    if (refSees(state, p)) {
      callFoul(state, p, type, h.team);
      return;
    }
    chance = 0.75;
    if (state.crng.chance(0.5)) say(state, 'unseen', p.team, p, ` gets away with some ${FOUL_NAMES[type]} there. The referee missed it!`);
  }
  const partner = state.players.find((o) => o !== p && o.team === p.team && o.role === 'chaser' && active(o) && dist(o, h) < 9);
  if (partner) chance += 0.15;
  state.events.push({ type: 'tackle', x: h.x, y: h.y, z: h.z });
  if (!rng.chance(chance)) return;
  if (partner && state.crng.chance(0.6)) say(state, 'move', p.team, p, ' and ', partner, ' close in. Parkin’s Pincer!');
  if (rng.chance(0.5)) {
    take(state, p, 'steal');
    say(state, 'steal', p.team, p, ` ${pick(state, ['snatches the Quaffle from', 'steals it off', 'rips it away from'])} `, h);
  } else {
    loose(state, h.vx + rng.range(-15, 15), h.vy + rng.range(-15, 15), h.vz + rng.range(-5, 8));
  }
}

function holderThink(state, p) {
  const rng = state.rng;
  const t = state.teams[p.team];
  const tac = TACTICS[t.tactic];
  const dir = t.dir;
  const endX = dir * HOOP_X;
  const dGoal = Math.hypot(endX - p.x, p.y, 46 - p.z);
  const { o: near, d: press } = nearestOpponent(state, p);
  if (dir * p.x > SCORING_X - 20 && dGoal < 80 && dir * p.x < HOOP_X - 8) {
    const want = 0.17 * tac.shoot + (dGoal < 45 ? 0.3 : 0) + (press < 8 ? 0.25 : 0);
    if (rng.chance(want)) return shoot(state, p);
  }
  const best = bestPass(state, p, tac);
  if (best) {
    const want = (press < 9 ? 0.45 : press < 18 ? 0.12 : 0.035) * tac.pass + (tac.long && best.gain > 50 ? 0.12 : 0);
    if (rng.chance(want)) return pass(state, p, best.mate, press);
  }
  // Carry it forward, away from the nearest defender.
  let gy = p.y * 0.6;
  if (near && press < 25) gy += (p.y >= near.y ? 1 : -1) * 22;
  if (press < 12 && state.time > p.shimmyUntil + 4 && rng.chance(0.008 + 0.025 * p.skill.agility)) {
    p.shimmyUntil = state.time + 2;
    say(state, 'move', p.team, p, ' weaves through with a Woollongong Shimmy');
  }
  if (state.time < p.shimmyUntil) gy += Math.sin(state.time * 9) * 16;
  let gx = p.x + dir * 45;
  if (dir * gx > HOOP_X - 25) gx = dir * (HOOP_X - 25);
  goTo(p, gx, clamp(gy, -60, 60), p.z + (44 - p.z) * 0.5, 1);
}

function segDist(ax, ay, az, bx, by, bz, c) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  const t = l2 ? clamp(((c.x - ax) * dx + (c.y - ay) * dy + (c.z - az) * dz) / l2, 0, 1) : 0;
  return Math.hypot(ax + dx * t - c.x, ay + dy * t - c.y, az + dz * t - c.z);
}

function passSpeed(p) {
  return 60 + 20 * p.skill.throwing;
}

// Where to aim a pass: ahead of the receiver, but only partly, since they'll come to it.
function lead(p, m, speed) {
  let t = dist(p, m) / speed;
  for (let i = 0; i < 2; i++) t = Math.hypot(m.x + m.vx * t * 0.6 - p.x, m.y + m.vy * t * 0.6 - p.y, m.z + m.vz * t * 0.6 - p.z) / speed;
  return { x: m.x + m.vx * t * 0.6, y: m.y + m.vy * t * 0.6, z: Math.max(4, m.z + m.vz * t * 0.6) };
}

function bestPass(state, p, tac) {
  const dir = state.teams[p.team].dir;
  let best = null;
  for (const m of state.players) {
    if (m === p || m.team !== p.team || m.role !== 'chaser' || !active(m)) continue;
    const L = lead(p, m, passSpeed(p));
    const len = Math.hypot(L.x - p.x, L.y - p.y, L.z - p.z);
    if (len < 12 || len > (tac.long ? 150 : 110)) continue;
    let open = 40;
    for (const o of state.players) {
      if (o.team === p.team || !active(o) || !handles(o)) continue;
      open = Math.min(open, segDist(p.x, p.y, p.z, L.x, L.y, L.z, o));
    }
    const gain = dir * (L.x - p.x);
    let score = gain * 0.03 + Math.min(open, 30) * 0.06 - 0.8 - Math.max(0, len - 80) * 0.02;
    if (open < 5) score -= 2;
    if (dir * L.x > SCORING_X && dir * p.x > SCORING_X) score -= 5; // would be stooging
    if (!best || score > best.score) best = { mate: m, score, gain };
  }
  return best && best.score > 0 ? best : null;
}

function pass(state, p, m, press = 99) {
  const speed = passSpeed(p);
  const L = lead(p, m, speed);
  const err = 0.012 + (1 - p.skill.throwing) * 0.05 + (press < 8 ? 0.02 : 0);
  throwBall(state, p, L.x, L.y, L.z, speed, 'pass', m, err);
  p.stats.passes++;
  const dir = state.teams[p.team].dir;
  if (press < 15 && m.z < p.z - 18 && state.crng.chance(0.6)) say(state, 'move', p.team, p, ' draws them up and drops it to ', m, '. The Porskoff Ploy!');
  else if (press < 10 && dir * (m.x - p.x) < -12 && state.crng.chance(0.4)) say(state, 'move', p.team, p, ' finds ', m, ' with a Reverse Pass');
}

function shoot(state, p, penalty = false) {
  const rng = state.rng;
  const t = state.teams[p.team];
  const dir = t.dir;
  const endX = dir * HOOP_X;
  const keeper = state.players.find((o) => o.team !== p.team && o.role === 'keeper' && !o.out);
  let hoop = 1, bestScore = -Infinity;
  HOOPS.forEach((h, i) => {
    const ring = { x: endX, y: h.y, z: h.z };
    const s = (keeper && active(keeper) ? dist(keeper, ring) : 30) - 0.25 * dist(p, ring) + rng.range(0, 16);
    if (s > bestScore) {
      bestScore = s;
      hoop = i;
    }
  });
  const h = HOOPS[hoop];
  const { d: press } = nearestOpponent(state, p);
  const speed = 62 + 24 * p.skill.throwing;
  const err = 0.012 + (1 - p.skill.throwing) * 0.045 + (!penalty && press < 8 ? 0.025 : 0);
  const close = Math.hypot(endX - p.x, h.y - p.y, h.z - p.z) < 16;
  throwBall(state, p, endX + dir * 3, h.y, h.z, speed, 'shot', null, err);
  const q = state.quaffle;
  q.hoop = hoop;
  q.penalty = penalty;
  q.haversack = close && rng.chance((1.1 - p.skill.discipline) * 0.25);
  // Quaffle-pocking: a doctored ball that swerves in flight.
  q.pocked = rng.chance(0.004 * (1.2 - p.skill.discipline));
  p.stats.shots++;
}

function penaltyTaker(state, team) {
  let best = null;
  for (const p of state.players) {
    if (p.team !== team || p.role !== 'chaser' || !active(p)) continue;
    if (!best || p.skill.throwing > best.skill.throwing) best = p;
  }
  return best;
}

function penaltyChaser(state, p) {
  const pen = state.penalty;
  const q = state.quaffle;
  const dir = state.teams[pen.team].dir;
  if (p === pen.taker) {
    goTo(p, dir * PENALTY_X, 0, 44, 0.9);
    const atSpot = Math.hypot(p.x - dir * PENALTY_X, p.y, p.z - 44) < 6;
    if (q.holder === p && ((atSpot && state.phaseT > 2.4) || state.phaseT > 9)) {
      shoot(state, p, true);
      if (state.phase === 'penalty') setPhase(state, 'play');
    }
    return;
  }
  // Everyone else waits outside the scoring area.
  let gx = p.x;
  if (dir * gx > SCORING_X - 25) gx = dir * (SCORING_X - 25);
  goTo(p, gx, clamp(p.y, -60, 60), clamp(p.z, 20, 60), 0.6);
}

// Keepers --------------------------------------------------------------------------

// Every step, not every think: a Keeper reads the shot and dives for where it will cross.
function keeperReact(state) {
  const q = state.quaffle;
  if (q.flight !== 'shot') return;
  for (const p of state.players) {
    if (p.role !== 'keeper' || !active(p) || p.team === q.team) continue;
    const s = state.teams[p.team].side;
    if (Math.sign(q.vx) !== s) continue;
    if (p.reactAt === null) p.reactAt = state.time + 0.28 - 0.2 * p.skill.keeping;
    if (state.time < p.reactAt || p.glide > 0) continue;
    const tt = (p.x - q.x) / q.vx;
    if (tt <= 0.02) continue;
    const b = ballAt(q, tt);
    const d = Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z);
    const sp = Math.min(d / tt, 40 + 32 * p.skill.keeping);
    p.vx = ((b.x - p.x) / (d || 1)) * sp;
    p.vy = ((b.y - p.y) / (d || 1)) * sp;
    p.vz = ((b.z - p.z) / (d || 1)) * sp;
    p.glide = Math.min(tt, 1) + 0.15;
  }
}

function thinkKeeper(state, p) {
  const q = state.quaffle;
  const t = state.teams[p.team];
  const s = t.side;
  const guardX = s * (HOOP_X - 7);
  const rng = state.rng;
  if (q.holder === p) {
    const held = state.time - p.holdAt;
    const best = bestPass(state, p, { long: true });
    if (held > 0.9 && best && rng.chance(0.4)) return pass(state, p, best.mate);
    if (held > 3.5) goTo(p, p.x - s * 40, p.y * 0.5, 40, 0.8);
    else goTo(p, guardX - s * 12, p.y * 0.8, 44, 0.4);
    return;
  }
  if (state.phase === 'penalty' && state.penalty.team !== p.team && q.flight !== 'shot') {
    p.reactAt = null;
    goTo(p, guardX, 0, 46, 0.9);
    return;
  }
  if (q.flight === 'shot' && q.team !== p.team && Math.sign(q.vx) === s) return; // keeperReact() has it
  p.reactAt = null;
  // Claim a loose ball in the scoring area.
  if (!q.holder && (q.flight === 'loose' || (q.flight === 'pass' && q.team !== p.team)) && s * q.x > SCORING_X - 10) {
    const mine = state.players.filter((o) => o.team === p.team && handles(o) && active(o));
    if (mine.every((o) => o === p || dist(o, q) >= dist(p, q))) return chaseBall(state, p);
  }
  const by = q.holder ? q.holder.y : q.y, bz = q.holder ? q.holder.z : q.z;
  const threat = s * q.x > 60;
  goTo(p, guardX, clamp(by * (threat ? 0.35 : 0.15), -24, 24), clamp(46 + (bz - 46) * 0.3, 34, 54), threat ? 0.9 : 0.5);
}

// Beaters --------------------------------------------------------------------------

function thinkBeater(state, p) {
  const q = state.quaffle;
  let best = null, bs = Infinity;
  for (const b of state.bludgers) {
    if (b.mode === 'crate') continue;
    if (b.mode === 'struck' && b.lastBy?.team === p.team && b.struckT > 0.4) continue; // our own shot
    const d = dist(p, b);
    const threat = b.mode === 'roam' && b.target && b.target.team === p.team;
    const s = d - (threat ? 40 : 0) - (p.duty === 'hunt' ? 20 : 0);
    if (s < bs) {
      bs = s;
      best = b;
    }
  }
  let protect = null;
  if (p.duty === 'screen') protect = state.players.find((o) => o.team === p.team && o.role === 'seeker' && !o.out);
  else if (p.duty === 'guard') {
    protect = q.holder?.team === p.team ? q.holder : null;
    if (!protect) {
      let bd = Infinity;
      for (const o of state.players) {
        if (o.team !== p.team || o.role !== 'chaser' || o.out) continue;
        const d = dist(o, q);
        if (d < bd) {
          bd = d;
          protect = o;
        }
      }
    }
  }
  const hunting = best && (protect ? dist(best, protect) < 70 || dist(best, p) < 40 : dist(best, p) < 170);
  if (hunting) {
    const bs2 = Math.hypot(best.vx, best.vy, best.vz);
    const tau = dist(p, best) / (p.maxSpeed + bs2);
    p.low = best.z < FLOOR;
    goTo(p, best.x + best.vx * tau, best.y + best.vy * tau, best.z + best.vz * tau, 1);
    return;
  }
  if (protect) {
    const side = p.id % 2 ? 1 : -1;
    goTo(p, protect.x - protect.vx * 0.3, protect.y + side * 10, protect.z + 8, 0.85);
  } else {
    goTo(p, q.x * 0.7, q.y * 0.5 + (p.id % 2 ? 25 : -25), 40, 0.6);
  }
}

// Seekers --------------------------------------------------------------------------

const seekerOf = (state, team) => state.players.find((o) => o.team === team && o.role === 'seeker' && !o.out);
// Catching the Snitch ends the match, so a Seeker more than 150 behind usually won't.
const losingBig = (state, team) => state.teams[1 - team].score - state.teams[team].score > SNITCH_POINTS;

function thinkSeeker(state, p) {
  const rng = state.rng;
  const s = state.snitch;
  const other = seekerOf(state, 1 - p.team);
  if (!s.released) return;
  switch (p.mode) {
    case 'feint': {
      p.boost = 1.12;
      goTo(p, p.x + p.vx * 0.4, p.y + p.vy * 0.4, 0, 1);
      if (p.z < 9) {
        p.mode = 'search';
        state.events.push({ type: 'pullout', x: p.x, y: p.y, z: p.z });
      }
      return;
    }
    case 'follow': {
      const f = p.fooledBy;
      p.boost = 1.12;
      goTo(p, f.x, f.y, Math.max(0, f.z - 5), 1);
      if (p.z < 13) {
        p.mode = 'search';
        if (rng.chance(0.55 * (1.1 - p.skill.agility))) {
          p.stun = 5;
          p.vz = -20;
          state.events.push({ type: 'crash', x: p.x, y: p.y, z: 0 });
          if (rng.chance(0.15)) knockOut(state, p, [' ploughs into the ground and is out of the match']);
          else say(state, 'crash', p.team, p, ' ploughs into the turf! Shaken, but back up');
        } else {
          say(state, 'move', p.team, p, ' pulls out just in time');
        }
      }
      return;
    }
    case 'chase': {
      const d = dist(p, s);
      p.lost = d > 110 || s.mode === 'hover' && d > 60 ? p.lost + 0.2 : 0;
      // A long chase usually ends with the Snitch slipping away.
      if (state.time - p.chaseAt > 9 && rng.chance(0.03)) p.lost = 9;
      if (p.lost > 1.6) {
        p.mode = 'search';
        p.lost = 0;
        p.blindUntil = state.time + 12;
        const long = state.time - p.chaseAt > 3;
        if (s.mode !== 'flee') {
          newDart(state, s);
          s.mode = 'dart';
          s.speed = 90;
        }
        if (long) say(state, 'lost', p.team, p, pick(state, [' has lost sight of the Snitch', ' pulls up. The Snitch has vanished again', '. Gone! The Snitch gives them the slip']));
        return;
      }
      const k = Math.min(0.4, d / 120);
      p.boost = d < 10 ? 1.3 : 1.1; // the final lunge
      p.brake = false;
      p.low = s.z < FLOOR + 1;
      goTo(p, s.x + s.vx * k, s.y + s.vy * k, s.z + s.vz * k, 1);
      return;
    }
  }
  // Searching: circle high above the game and watch.
  p.patrol += 0.035 * (p.team ? 1 : -1);
  const R = 70 + 40 * Math.sin(p.patrol * 0.37 + p.id);
  goTo(p, Math.cos(p.patrol) * R * 1.6, Math.sin(p.patrol) * R * 0.5, 80 + 18 * Math.sin(state.time * 0.3 + p.id), 0.55);
  const d = dist(p, s);
  const showing = s.mode === 'hover' ? 1 : 0.3;
  const pace = 0.2 + state.time / 240;
  if (state.time > p.blindUntil && rng.chance(SPOT_RATE * p.skill.vision * showing * pace / (1 + d / 120))) {
    p.mode = 'chase';
    p.lost = 0;
    p.chaseAt = state.time;
    state.events.push({ type: 'spot', x: p.x, y: p.y, z: p.z, team: p.team });
    say(state, 'spot', p.team, p, pick(state, [' has seen the Snitch!', ' is diving. The Snitch!', ' is off like a shot. Have they seen it?']));
    return;
  }
  if (other && other.mode === 'chase' && state.time > p.blindUntil && dist(p, other) < 220 && rng.chance(0.2 + 0.4 * p.skill.vision)) {
    p.mode = 'chase';
    p.lost = 0;
    p.chaseAt = state.time;
    say(state, 'spot', p.team, p, pick(state, [' gives chase', ' is after them', ' has seen it too!']));
    return;
  }
  if (other && other.mode === 'search' && active(other) && p.z > 50 && dist(p, other) < 70 && rng.chance(0.0008 + 0.0016 * p.skill.agility)) {
    p.mode = 'feint';
    say(state, 'move', p.team, p, ' dives for the ground. Is it the Snitch?');
    if (rng.chance(1 - other.skill.vision * 0.8)) {
      other.mode = 'follow';
      other.fooledBy = p;
      say(state, 'move', p.team, other, ' follows them down. A Wronski Feint!');
    }
  }
}

// --- the Quaffle -------------------------------------------------------------------

function throwBall(state, p, tx, ty, tz, speed, kind, receiver, err) {
  const rng = state.rng;
  const q = state.quaffle;
  q.x = p.x;
  q.y = p.y;
  q.z = p.z + 1;
  const d = Math.hypot(tx - q.x, ty - q.y, tz - q.z);
  tx += rng.gauss() * d * err;
  ty += rng.gauss() * d * err;
  tz += rng.gauss() * 0.6 * d * err;
  const T = Math.max(0.2, d / speed);
  q.vx = (tx - q.x) / T;
  q.vy = (ty - q.y) / T;
  q.vz = (tz - q.z) / T + 0.5 * G_Q * T;
  q.holder = null;
  q.flight = kind;
  q.thrower = p;
  q.team = p.team;
  q.receiver = receiver;
  q.haversack = false;
  q.pocked = false;
  q.penalty = false;
  q.tried.fill(-9);
  q.tried[p.id] = state.time + 0.4;
  p.swing = 1;
  state.events.push({ type: 'throw', kind, x: q.x, y: q.y, z: q.z, team: p.team });
}

function take(state, p, how) {
  const q = state.quaffle;
  q.holder = p;
  q.flight = 'held';
  q.team = p.team;
  q.receiver = null;
  q.thrower = null;
  p.holdAt = state.time;
  state.events.push({ type: 'catch', how, x: p.x, y: p.y, z: p.z, team: p.team });
}

function loose(state, vx, vy, vz) {
  const q = state.quaffle;
  q.holder = null;
  q.flight = 'loose';
  q.receiver = null;
  q.vx = vx;
  q.vy = vy;
  q.vz = vz;
  q.tried.fill(-9);
}

// The referee hands the Quaffle to `p` (after a goal, foul or out of bounds).
function feed(state, p) {
  const q = state.quaffle;
  q.holder = null;
  q.flight = 'feed';
  q.receiver = p;
  q.restartTeam = p.team;
}

function restartTo(state, team, keeperFirst) {
  const q = state.quaffle;
  let r = keeperFirst ? state.players.find((p) => p.team === team && p.role === 'keeper' && active(p)) : null;
  if (!r) {
    let bd = Infinity;
    for (const p of state.players) {
      if (p.team !== team || !handles(p) || !active(p)) continue;
      const d = dist(p, q);
      if (d < bd) {
        bd = d;
        r = p;
      }
    }
  }
  if (r) feed(state, r);
  else {
    q.flight = 'dead';
    q.deadT = 1;
  }
}

function updateQuaffle(state, dt) {
  const q = state.quaffle;
  const rng = state.rng;
  if (q.flight === 'ref') {
    const r = state.referee;
    Object.assign(q, { x: r.x + 2, y: r.y, z: r.z + 1 });
    return;
  }
  if (q.holder) {
    const p = q.holder;
    q.x = p.x + Math.cos(p.heading + 0.9) * 1.6;
    q.y = p.y + Math.sin(p.heading + 0.9) * 1.6;
    q.z = p.z + 1.5;
    q.vx = p.vx;
    q.vy = p.vy;
    q.vz = p.vz;
    return;
  }
  if (q.flight === 'dead') {
    q.deadT -= dt;
    q.vx *= Math.exp(-dt * 2);
    q.vy *= Math.exp(-dt * 2);
    q.vz = Math.max(-10, q.vz - G_Q * dt);
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    q.z = Math.max(0.6, q.z + q.vz * dt);
    if (q.deadT <= 0 && state.phase !== 'timeout') restartTo(state, q.restartTeam ?? 0, q.toKeeper);
    return;
  }
  if (q.flight === 'feed') {
    const r = q.receiver;
    if (!r || !active(r)) {
      restartTo(state, q.restartTeam, false);
      return;
    }
    const d = dist(q, r);
    if (d < 3) return take(state, r, 'feed');
    const sp = Math.min(d / dt, 85);
    q.vx = ((r.x - q.x) / d) * sp;
    q.vy = ((r.y - q.y) / d) * sp;
    q.vz = ((r.z - q.z) / d) * sp;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    q.z += q.vz * dt;
    return;
  }

  // In flight or loose: gentle gravity, a little wind, drag once it's loose.
  const px = q.x;
  const w = state.match.wind;
  q.vx += w.x * 0.12 * dt;
  q.vy += w.y * 0.12 * dt;
  q.vz -= G_Q * dt;
  if (q.pocked) q.vy += Math.sin(state.time * 7) * 40 * dt;
  if (q.flight === 'loose') {
    const k = Math.exp(-dt * 1.2);
    q.vx *= k;
    q.vy *= k;
  }
  q.x += q.vx * dt;
  q.y += q.vy * dt;
  q.z += q.vz * dt;
  if (q.z < 0.6) {
    q.z = 0.6;
    q.vz = q.vz < -4 ? -q.vz * 0.3 : 0;
    const k = Math.exp(-dt * 2);
    q.vx *= k;
    q.vy *= k;
    if (q.flight !== 'loose') loose(state, q.vx, q.vy, q.vz);
  }

  // Through a hoop?
  for (const s of [-1, 1]) {
    const plane = s * HOOP_X;
    if ((px - plane) * (q.x - plane) > 0 || px === q.x) continue;
    const f = (plane - px) / (q.x - px);
    const cy = q.y - q.vy * dt * (1 - f), cz = q.z - q.vz * dt * (1 - f);
    for (let i = 0; i < HOOPS.length; i++) {
      const h = HOOPS[i];
      const off = Math.hypot(cy - h.y, cz - h.z);
      if (off <= HOOP_R - 0.6 && Math.sign(q.vx) === s) {
        if (goal(state, s, i)) return;
      } else if (off < HOOP_R + 0.8 && off > HOOP_R - 0.6) {
        // Off the ring.
        q.vx = -q.vx * 0.35;
        q.vy += rng.range(-12, 12);
        q.vz = rng.range(-4, 12);
        q.x = px;
        if (q.flight === 'shot') {
          state.events.push({ type: 'rim', x: q.x, y: q.y, z: q.z });
          say(state, 'miss', q.team, q.thrower, pick(state, [' hits the hoop!', '. Off the ring!', '. So close, it rattles off the hoop']));
        }
        loose(state, q.vx, q.vy, q.vz);
        return;
      }
    }
  }

  // Out of bounds: possession goes to the other side.
  if (!inside(q.x, q.y, 8)) {
    whistle(state);
    const to = 1 - (q.team ?? 0);
    if (q.flight === 'shot' && q.thrower) {
      say(state, 'miss', q.thrower.team, q.thrower, pick(state, [' shoots wide', '. Wide of the hoops', ' misses. Wide!']));
    } else {
      say(state, 'out', to, 'Out of bounds. ', state.teams[to], ' ball');
    }
    q.toKeeper = q.flight === 'shot';
    q.flight = 'dead';
    q.deadT = 0.6;
    q.restartTeam = to;
    const [ex, ey] = edgePoint(Math.atan2(q.y, q.x), -6);
    Object.assign(q, { x: ex, y: ey, vx: 0, vy: 0, vz: 0 });
    return;
  }

  // Catches, interceptions and saves.
  for (const p of state.players) {
    if (!handles(p) || !active(p)) continue;
    if (state.phase === 'penalty' && p !== state.penalty?.taker && p.role !== 'keeper') continue;
    const reach = p.role === 'keeper' ? 5 + 2.5 * p.skill.keeping : 3.5 + 2 * p.skill.catching;
    const d = dist(p, q);
    if (d > reach || q.tried[p.id] > state.time) continue;
    q.tried[p.id] = state.time + 0.35;
    const speed = Math.hypot(q.vx, q.vy, q.vz);
    if (q.flight === 'shot' && p.team === q.team) continue;
    if (q.flight === 'shot') {
      const isKeeper = p.role === 'keeper';
      const chance = isKeeper ? 0.5 + 0.42 * p.skill.keeping - (speed - 75) / 200 : 0.12 + 0.2 * p.skill.catching;
      if (!rng.chance(chance)) continue;
      if (isKeeper && rng.chance((1.1 - p.skill.discipline) * 0.06) && refSees(state, p)) {
        callFoul(state, p, 'flacking', q.team);
        return;
      }
      p.stats.saves += isKeeper ? 1 : 0;
      state.events.push({ type: 'save', x: q.x, y: q.y, z: q.z, team: p.team });
      const shooter = q.thrower;
      const wasPenalty = q.penalty;
      if (rng.chance(0.35 + 0.35 * p.skill.catching)) take(state, p, 'save');
      else loose(state, -q.vx * 0.3 + rng.range(-8, 8), q.vy * 0.3 + rng.range(-20, 20), rng.range(4, 16));
      q.team = p.team;
      if (wasPenalty && isKeeper) {
        say(state, 'save', p.team, p, ` saves the penalty with a ${pick(state, ['Double Eight Loop', 'Starfish and Stick', 'full-stretch dive'])}!`);
      } else if (isKeeper) {
        say(state, 'save', p.team, p, pick(state, [' saves from ', ' keeps out ', ' denies ']), shooter);
      } else {
        say(state, 'save', p.team, p, ' blocks the shot from ', shooter);
      }
      return;
    }
    let chance;
    if (q.flight === 'pass' && p === q.receiver) chance = 0.72 + 0.26 * p.skill.catching - Math.max(0, speed - 70) / 300;
    else if (q.flight === 'pass') chance = 0.22 + 0.4 * p.skill.catching;
    else if (q.flight === 'shot') chance = 0.6;
    else chance = 0.55 + 0.4 * p.skill.catching;
    if (rng.chance(chance)) {
      const intercepted = q.flight === 'pass' && p.team !== q.team;
      take(state, p, intercepted ? 'intercept' : 'catch');
      if (intercepted) say(state, 'intercept', p.team, p, pick(state, [' intercepts!', ' cuts out the pass', ' reads it and picks it off']));
      return;
    } else if (q.flight === 'pass' && p === q.receiver) {
      q.vx *= 0.6;
      q.vy *= 0.6;
      q.vz = rng.range(-2, 6);
      loose(state, q.vx, q.vy, q.vz);
      state.events.push({ type: 'fumble', x: q.x, y: q.y, z: q.z });
    }
  }
}

function goal(state, end, hoop) {
  const q = state.quaffle;
  const scorer = end === 1 ? 0 : 1; // team 0 attacks the +x end
  const shooter = q.thrower;
  if ((q.haversack || q.pocked) && shooter) {
    const type = q.haversack ? 'haversacking' : 'quafflepocking';
    q.haversack = q.pocked = false;
    if (refSees(state, shooter, 0.15)) {
      q.flight = 'dead';
      q.deadT = 2;
      q.restartTeam = 1 - shooter.team;
      q.toKeeper = false;
      callFoul(state, shooter, type, 1 - shooter.team, 'No goal! ');
      return true;
    }
  }
  const team = state.teams[scorer];
  team.score += GOAL_POINTS;
  if (shooter && shooter.team === scorer) shooter.stats.goals++;
  state.events.push({ type: 'goal', x: q.x, y: q.y, z: q.z, team: scorer, end });
  const keeper = state.players.find((p) => p.team !== scorer && p.role === 'keeper' && !p.out);
  if (!shooter || shooter.team !== scorer) {
    say(state, 'goal', scorer, 'Ten points to ', team, '! It went in off a defender');
  } else if (q.penalty) {
    say(state, 'goal', scorer, shooter, pick(state, [' converts the penalty', ' scores from the spot', ' sends the keeper the wrong way. Penalty scored']));
  } else {
    const lines = [
      [shooter, ' scores! Ten points to ', team],
      ['GOAL! ', shooter, ` through the ${HOOP_NAMES[hoop]} hoop`],
      ...(keeper ? [[shooter, ' beats ', keeper, '. Ten points!']] : []),
      [shooter, ` puts it through the ${HOOP_NAMES[hoop]} hoop`],
    ];
    say(state, 'goal', scorer, ...pick(state, lines));
  }
  q.flight = 'dead';
  q.deadT = 1.3;
  q.restartTeam = 1 - scorer;
  q.toKeeper = true;
  q.holder = null;
  return true;
}

// --- Bludgers -------------------------------------------------------------------------

function pickBludgerTarget(state, h) {
  const q = state.quaffle;
  let best = null, bs = 0;
  for (const o of state.players) {
    if (o.team === h.team || o.out) continue;
    const d = dist(o, h);
    if (d > 160) continue;
    let w = o.role === 'beater' ? 0.5 : 1.2;
    if (q.holder === o) w = 3;
    if (o.role === 'seeker') w = o.mode === 'chase' ? 2.5 : 1;
    if (o.role === 'keeper') w = q.flight === 'shot' ? 2 : 0.8;
    const s = w / (1 + d / 60);
    if (s > bs) {
      bs = s;
      best = o;
    }
  }
  return best;
}

function beaterHit(state, h, b, partner) {
  const rng = state.rng;
  const tac = TACTICS[state.teams[h.team].tactic];
  h.hitCd = 0.6;
  h.swing = 1;
  b.cd = 0.35;
  let speed = 92 + 40 * h.skill.power;
  if (partner) {
    partner.hitCd = 0.6;
    partner.swing = 1;
    speed *= 1.3;
  }
  const tgt = pickBludgerTarget(state, h);
  let ax, ay, az;
  const bumph = rng.chance(0.003 * tac.aggression * (1.2 - h.skill.discipline));
  if (bumph) {
    const [ex, ey] = edgePoint(Math.atan2(h.y, h.x) + rng.range(-0.4, 0.4), 60);
    [ax, ay, az] = [ex, ey, 30];
  } else if (tgt) {
    let t = dist(b, tgt) / speed;
    t = Math.hypot(tgt.x + tgt.vx * t - b.x, tgt.y + tgt.vy * t - b.y, tgt.z + tgt.vz * t - b.z) / speed;
    [ax, ay, az] = [tgt.x + tgt.vx * t, tgt.y + tgt.vy * t, tgt.z + tgt.vz * t];
  } else {
    // Nobody in range: knock it away towards the other half.
    const dir = state.teams[h.team].dir;
    [ax, ay, az] = [h.x + dir * 80, h.y + rng.range(-40, 40), h.z + rng.range(-10, 10)];
    speed *= 0.7;
  }
  let dx = ax - b.x, dy = ay - b.y, dz = az - b.z;
  const L = Math.hypot(dx, dy, dz) || 1;
  const err = 0.03 + (1 - h.skill.aim) * 0.12;
  const yaw = Math.atan2(dy, dx) + rng.gauss() * 2 * err;
  const pitch = Math.asin(clamp(dz / L, -1, 1)) + rng.gauss() * err;
  b.vx = Math.cos(yaw) * Math.cos(pitch) * speed;
  b.vy = Math.sin(yaw) * Math.cos(pitch) * speed;
  b.vz = Math.sin(pitch) * speed;
  b.mode = 'struck';
  b.struckT = 1.6;
  b.lastBy = h;
  b.lastAt = state.time;
  b.target = tgt;
  state.events.push({ type: 'bat', x: b.x, y: b.y, z: b.z, power: speed / 130, team: h.team });
  if (bumph) {
    if (refSees(state, h, 0.3)) callFoul(state, h, 'bumphing', 1 - h.team);
    return;
  }
  if (partner && tgt && state.crng.chance(0.35)) say(state, 'move', h.team, h, ' and ', partner, ' hit it together. Dopplebeater Defence!');
  else if (tgt && (Math.cos(h.heading) * dx + Math.sin(h.heading) * dy) < -0.7 * L && state.crng.chance(0.04)) {
    say(state, 'move', h.team, h, ' sends it backwards at ', tgt, '. A Bludger Backbeat!');
  }
}

function updateBludgers(state, dt) {
  const rng = state.rng;
  for (const b of state.bludgers) {
    if (b.mode === 'crate') continue;
    b.cd -= dt;
    if (b.mode === 'struck') {
      b.struckT -= dt;
      const k = Math.exp(-dt * 0.35);
      b.vx *= k;
      b.vy *= k;
      b.vz *= k;
      if (b.struckT <= 0) {
        b.mode = 'roam';
        b.retarget = 0;
      }
    } else {
      b.retarget -= dt;
      if (b.retarget <= 0 || !b.target || b.target.out) {
        const opts = state.players.filter((p) => !p.out).map((p) => [p, 1 / (1 + (dist(p, b) / 50) ** 2)]);
        b.target = opts.length ? rng.weighted(opts) : null;
        b.retarget = rng.range(2, 4);
      }
      let tx = 0, ty = 0, tz = 40;
      if (b.target) ({ x: tx, y: ty, z: tz } = b.target);
      if (!inside(b.x, b.y, 10)) {
        tx = 0;
        ty = 0;
      }
      const dx = tx - b.x, dy = ty - b.y, dz = tz - b.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      let ax = (dx / L) * BLUDGER_SPEED - b.vx, ay = (dy / L) * BLUDGER_SPEED - b.vy, az = (dz / L) * BLUDGER_SPEED - b.vz;
      const a = Math.hypot(ax, ay, az), lim = BLUDGER_ACCEL * dt;
      if (a > lim) {
        ax *= lim / a;
        ay *= lim / a;
        az *= lim / a;
      }
      b.vx += ax;
      b.vy += ay;
      b.vz += az;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    if (b.z < 1) {
      b.z = 1;
      b.vz = Math.abs(b.vz) * 0.6;
    }
    if (b.z > 170) b.vz = -Math.abs(b.vz);

    if (state.phase === 'release') continue;
    // Beaters within reach bat it away.
    if (b.cd <= 0) {
      const hitters = state.players.filter((p) => p.role === 'beater' && active(p) && p.hitCd <= 0 && dist(p, b) < HIT_REACH);
      if (hitters.length) {
        const h = hitters[0];
        const partner = hitters.find((o) => o !== h && o.team === h.team) ?? null;
        beaterHit(state, h, b, partner);
        continue;
      }
    }
    if (state.phase === 'timeout') continue;
    for (const p of state.players) {
      if (p.out) continue;
      if (b.lastBy === p && state.time - b.lastAt < 0.4) continue;
      const dx = p.x - b.x, dy = p.y - b.y, dz = p.z - b.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 16) continue;
      // See it coming and swerve.
      const closing = (b.vx - p.vx) * dx / d + (b.vy - p.vy) * dy / d + (b.vz - p.vz) * dz / d;
      if (p.role !== 'beater' && p.stun <= 0 && closing > 30 && state.time > p.dodgeAt[b.id]) {
        p.dodgeAt[b.id] = state.time + 1.2;
        const chance = 0.25 + 0.4 * p.skill.agility + 0.15 * state.teams[p.team].broom.handling - (b.mode === 'struck' ? 0.15 : 0);
        if (rng.chance(chance)) {
          const bs = Math.hypot(b.vx, b.vy) || 1;
          const side = (-b.vy * dx + b.vx * dy) >= 0 ? 1 : -1;
          const kick = 16 + 10 * p.skill.agility;
          p.vx += (-b.vy / bs) * side * kick;
          p.vy += (b.vx / bs) * side * kick;
          p.vz += rng.range(-8, 8);
          p.immune[b.id] = state.time + 0.6;
          p.roll = 1;
          state.events.push({ type: 'dodge', x: p.x, y: p.y, z: p.z });
          if (d < 9 && state.crng.chance(0.12)) say(state, 'move', p.team, p, ' rolls under it. A Sloth Grip Roll!');
        }
      }
      if (d < BONK_R + (b.mode === 'struck' ? 0.6 : 0) && state.time > p.immune[b.id]) bonk(state, b, p);
    }
  }
}

function bonk(state, b, p) {
  const rng = state.rng;
  const q = state.quaffle;
  const rel = Math.hypot(b.vx - p.vx, b.vy - p.vy, b.vz - p.vz);
  const struck = b.mode === 'struck' && b.lastBy;
  p.stun = 1.3 + rel / 70;
  p.vx += b.vx * 0.25;
  p.vy += b.vy * 0.25;
  p.vz -= 8;
  p.immune[b.id] = state.time + 1;
  if (p.role === 'seeker' && p.mode !== 'search') p.mode = 'search';
  if (q.holder === p) loose(state, p.vx + rng.range(-10, 10), p.vy + rng.range(-10, 10), rng.range(-4, 6));
  b.vx = -b.vx * 0.3 + rng.range(-10, 10);
  b.vy = -b.vy * 0.3 + rng.range(-10, 10);
  b.vz = rng.range(0, 15);
  b.mode = 'roam';
  b.retarget = 0.8;
  b.target = null;
  const by = struck && b.lastBy.team !== p.team ? b.lastBy : null;
  if (by) by.stats.hits++;
  // Seekers fly high and alone, and usually see it coming late but glancing.
  const ko = rng.chance(clamp(KO_BASE + (rel - 70) / 3000, 0.003, 0.025) * (p.role === 'seeker' ? 0.4 : 1));
  state.events.push({ type: 'bonk', x: p.x, y: p.y, z: p.z, ko, team: p.team });
  if (ko) {
    knockOut(state, p, by ? [' is knocked off their broom by ', by, '’s Bludger!'] : [' is knocked out cold by a Bludger!']);
  } else if (by && (q.flight === 'loose' && state.time - b.lastAt < 3 || p.role === 'seeker')) {
    say(state, 'bonk', by.team, by, pick(state, [' finds ', ' sends a Bludger into ', ' clatters ']), p);
  }
}

function knockOut(state, p, tail) {
  p.out = true;
  p.stun = 0;
  p.mode = 'out';
  const t = state.teams[p.team];
  say(state, 'ko', p.team, p, ...tail);
  const left = state.players.filter((o) => o.team === p.team && !o.out).length;
  say(state, 'ko', p.team, 'No substitutions: ', t, ` play on with ${left}`);
  if (state.snitch.holder === p) state.snitch.holder = null;
  if (!t.timeoutUsed && state.phase === 'play' && state.rng.chance(0.5)) {
    t.timeoutUsed = true;
    const q = state.quaffle;
    if (!q.holder && q.flight !== 'feed') {
      q.flight = 'dead';
      q.deadT = 0;
      q.restartTeam = q.team ?? p.team;
    }
    setPhase(state, 'timeout');
    whistle(state);
    const captain = state.players.find((o) => o.team === p.team && o.captain);
    say(state, 'timeout', p.team, ...(captain && !captain.out ? ['Captain ', captain, ' calls a time-out'] : [t, ' call a time-out']));
  }
}

// --- the Snitch -----------------------------------------------------------------------

function newDart(state, s) {
  const rng = state.rng;
  for (let i = 0; i < 10; i++) {
    const x = rng.range(-235, 235), y = rng.range(-85, 85);
    if (!inside(x, y, -15)) continue;
    s.tx = x;
    s.ty = y;
    break;
  }
  s.tz = 3 + 110 * rng.next() ** 2;
  s.speed = rng.range(35, 85);
  s.t = rng.range(2, 6);
}

function updateSnitch(state, dt) {
  const s = state.snitch;
  const rng = state.rng;
  if (!s.released) {
    Object.assign(s, { x: 0, y: 0, z: 1 });
    return;
  }
  s.t -= dt;
  s.jinkT -= dt;
  // Nearest chasing Seeker.
  let near = null, nd = Infinity;
  for (const p of state.players) {
    if (p.role !== 'seeker' || p.mode !== 'chase' || !active(p)) continue;
    const d = dist(p, s);
    if (d < nd) {
      nd = d;
      near = p;
    }
  }
  const tire = 1 - Math.min(0.2, state.time / 2500);
  let wx, wy, wz, sp;
  if (near && nd < 45) {
    // Flee, jinking sideways every few tenths of a second. It outpaces a fresh chase,
    // then tires, so a Seeker who hangs on gets a hand to it.
    s.mode = 'flee';
    s.energy = Math.max(0, s.energy - 0.15 * dt);
    if (s.jinkT <= 0) {
      s.jinkT = rng.range(0.25, 0.6);
      s.jx = rng.range(-1, 1);
      s.jy = rng.range(-1, 1);
      s.jz = rng.range(-0.6, 0.6);
    }
    const dx = s.x - near.x, dy = s.y - near.y, dz = s.z - near.z;
    const L = nd || 1;
    const j = 0.3 + 1.1 * s.energy; // a tired Snitch jinks less
    wx = dx / L + s.jx * j;
    wy = dy / L + s.jy * j;
    wz = dz / L + s.jz * j;
    // Steer away from the edge and the ground.
    if (!inside(s.x, s.y, -25)) {
      wx -= s.x / 120;
      wy -= s.y / 50;
    }
    if (s.z < 6) wz += 1;
    if (s.z > 120) wz -= 1;
    sp = Math.min(SNITCH_MAX, near.maxSpeed * (0.7 + 0.55 * s.energy)) * tire;
  } else {
    s.energy = Math.min(1, s.energy + 0.05 * dt);
    if (s.mode === 'flee') {
      s.mode = 'dart';
      newDart(state, s);
    }
    if (s.mode === 'hover') {
      if (s.t <= 0) {
        s.mode = 'dart';
        newDart(state, s);
      }
      wx = s.tx - s.x + Math.sin(state.time * 13) * 2;
      wy = s.ty - s.y + Math.cos(state.time * 11) * 2;
      wz = s.tz - s.z + Math.sin(state.time * 17) * 1.5;
      sp = 6;
    } else {
      const d = Math.hypot(s.tx - s.x, s.ty - s.y, s.tz - s.z);
      if (d < 5 || s.t <= 0) {
        if (rng.chance(0.45)) {
          s.mode = 'hover';
          s.t = rng.range(1.5, 4.5);
          s.tx = s.x;
          s.ty = s.y;
          s.tz = s.z;
        } else newDart(state, s);
      }
      wx = s.tx - s.x;
      wy = s.ty - s.y;
      wz = s.tz - s.z;
      sp = s.speed * tire;
    }
  }
  const L = Math.hypot(wx, wy, wz) || 1;
  const want = s.mode === 'hover' ? Math.min(sp, L * 3) : sp;
  let ax = (wx / L) * want - s.vx, ay = (wy / L) * want - s.vy, az = (wz / L) * want - s.vz;
  const a = Math.hypot(ax, ay, az), lim = SNITCH_ACCEL * dt;
  if (a > lim) {
    ax *= lim / a;
    ay *= lim / a;
    az *= lim / a;
  }
  s.vx += ax;
  s.vy += ay;
  s.vz += az;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.z = clamp(s.z + s.vz * dt, 1.5, 140);
  if (!inside(s.x, s.y, -6)) {
    const [ex, ey] = edgePoint(Math.atan2(s.y, s.x), -6);
    s.x = ex;
    s.y = ey;
  }
  if (state.phase === 'release' || state.phase === 'lineup') return;

  for (const p of state.players) {
    if (!active(p)) continue;
    const d = dist(p, s);
    if (p.role === 'seeker') {
      if (p.mode !== 'chase' || state.time < p.grabAt) continue;
      if (d > 3.5 + 2 * p.skill.agility) continue;
      p.grabAt = state.time + 0.35;
      // Behind by more than 150, a catch loses the match; the longer it drags on, the likelier they take it anyway.
      if (losingBig(state, p.team) && !rng.chance(0.1 + state.time / 900)) continue;
      if (rng.chance(0.08 + 0.2 * p.skill.agility + 0.3 * (1 - s.energy))) return catchSnitch(state, p);
      s.energy = Math.min(1, s.energy + 0.25);
      s.jinkT = 0;
      state.events.push({ type: 'near', x: s.x, y: s.y, z: s.z });
      if (state.crng.chance(0.4)) say(state, 'near', p.team, p, pick(state, [' reaches. Fingertips!', ' grasps at it and misses!', ' was inches away!']));
    } else if (d < 2 && state.time > p.grabAt) {
      p.grabAt = state.time + 3;
      if (rng.chance((1.1 - p.skill.discipline) * 0.2) && refSees(state, p)) callFoul(state, p, 'snitchnip', 1 - p.team);
    }
  }
}

function catchSnitch(state, p) {
  const s = state.snitch;
  const t = state.teams[p.team];
  t.score += SNITCH_POINTS;
  s.holder = p;
  state.catcher = p;
  state.events.push({ type: 'snitch', x: s.x, y: s.y, z: s.z, team: p.team });
  say(state, 'snitch', p.team, p, ' has caught the Snitch! 150 points to ', t);
  endMatch(state, 'snitch');
}

// --- the referee and fouls ------------------------------------------------------------

function updateReferee(state, dt) {
  const r = state.referee;
  const q = state.quaffle;
  if (state.phase === 'lineup') {
    Object.assign(r, { x: 0, y: 0, z: Math.min(14, r.z + dt * 6) });
    return;
  }
  const tx = clamp(q.x * 0.7, -170, 170), ty = clamp(q.y * 0.4 - 40, -70, 0), tz = clamp(q.z + 30, 40, 90);
  const k = 1 - Math.exp(-dt * 0.8);
  r.vx = (tx - r.x) * k / dt;
  r.vy = (ty - r.y) * k / dt;
  r.vz = (tz - r.z) * k / dt;
  r.x += r.vx * dt;
  r.y += r.vy * dt;
  r.z += r.vz * dt;
}

function refSees(state, p, bonus = 0) {
  const d = dist(state.referee, p);
  return state.rng.chance(clamp(0.92 - d / 700 + bonus, 0.3, 1));
}

function callFoul(state, offender, type, awardTo, prefix = '') {
  if (state.phase !== 'play') return false;
  const t = state.teams[offender.team];
  t.fouls++;
  offender.stats.fouls++;
  whistle(state);
  state.events.push({ type: 'foul', x: offender.x, y: offender.y, z: offender.z, team: offender.team });
  say(state, 'foul', offender.team, prefix, `${FOUL_NAMES[type]}! `, offender, ` (${FOULS[type]}). Penalty to `, state.teams[awardTo]);
  startPenalty(state, awardTo);
  return true;
}

function startPenalty(state, team) {
  const taker = penaltyTaker(state, team);
  if (!taker) return;
  setPhase(state, 'penalty');
  state.penalty = { team, taker };
  const q = state.quaffle;
  q.haversack = q.pocked = false;
  feed(state, taker);
}
