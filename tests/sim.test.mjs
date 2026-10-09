import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMatch, ROLES, SKILLS, TACTICS, BROOMS, WEATHERS } from '../js/gen.js';
import { createMatch, step, teamStats, MAX_TIME, GOAL_POINTS, SNITCH_POINTS, FOULS } from '../js/sim.js';
import { inside, edgePoint, HOOP_X, HALF_L, HALF_W } from '../js/pitch.js';

const SEEDS = [1, 42, 1337, 0xdeadbeef, 0x12345678, 987654321];

test('generation is deterministic for a seed', () => {
  const a = generateMatch(42), b = generateMatch(42);
  assert.deepEqual(a, b);
  assert.notDeepEqual(generateMatch(43).teams.map((t) => t.name), a.teams.map((t) => t.name));
});

test('every side is a legal seven', () => {
  for (let seed = 0; seed < 200; seed++) {
    const m = generateMatch(seed);
    assert.equal(m.teams.length, 2);
    assert.notEqual(m.teams[0].town, m.teams[1].town);
    assert.ok(WEATHERS.includes(m.weather));
    const names = new Set();
    for (const t of m.teams) {
      assert.deepEqual(t.players.map((p) => p.role), ROLES, 'one Keeper, three Chasers, two Beaters, one Seeker');
      assert.ok(TACTICS[t.tactic]);
      assert.ok(BROOMS.includes(t.broom));
      assert.equal(t.players.filter((p) => p.captain).length, 1);
      assert.equal(new Set(t.players.map((p) => p.number)).size, 7);
      for (const p of t.players) {
        names.add(p.surname);
        for (const k of SKILLS) assert.ok(p.skill[k] > 0 && p.skill[k] <= 1, `${p.name}.${k}`);
      }
    }
    assert.equal(names.size, 14, `seed ${seed}: duplicate surnames`);
  }
});

test('pitch geometry is consistent', () => {
  for (let a = 0; a < Math.PI * 2; a += 0.1) {
    const [x, y] = edgePoint(a);
    assert.ok(inside(x * 0.999, y * 0.999) && !inside(x * 1.01, y * 1.01));
    const [gx, gy] = edgePoint(a, 10);
    assert.ok(inside(gx * 0.999, gy * 0.999, 10) && !inside(gx * 0.999, gy * 0.999));
  }
  assert.ok(inside(HOOP_X, 30) && HOOP_X < HALF_L && 30 < HALF_W);
});

test('matches always end, with a score that adds up', () => {
  const seen = { goal: 0, save: 0, foul: 0, snitch: 0 };
  for (const seed of SEEDS) {
    const s = createMatch(seed);
    while (!s.over) {
      step(s, 1 / 30);
      s.events.length = 0;
      for (const p of s.players) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), `seed ${seed}: NaN position`);
        if (!p.out) assert.ok(inside(p.x, p.y, 1), `seed ${seed}: ${p.name} left the pitch`);
      }
      const q = s.quaffle;
      if (q.holder) assert.ok(q.holder.role === 'chaser' || q.holder.role === 'keeper', 'only Chasers and Keepers handle the Quaffle');
    }
    assert.ok(s.endT <= MAX_TIME + 0.1, `seed ${seed} ran ${s.endT}s`);
    for (const t of s.teams) {
      const goals = s.players.filter((p) => p.team === t.index).reduce((n, p) => n + p.stats.goals, 0);
      const snitch = s.catcher?.team === t.index ? SNITCH_POINTS : 0;
      // Goals credited to players, plus any deflected in off a defender.
      const deflected = s.log.filter((e) => e.kind === 'goal' && e.team === t.index && e.parts[0] === 'Ten points to ').length;
      assert.equal(t.score, (goals + deflected) * GOAL_POINTS + snitch, `seed ${seed}: ${t.name}`);
    }
    if (s.endReason === 'snitch') {
      assert.equal(s.catcher.role, 'seeker');
      assert.equal(s.snitch.holder, s.catcher);
    }
    const [a, b] = s.teams;
    assert.equal(s.winner, a.score === b.score ? null : a.score > b.score ? a : b);
    for (const st of teamStats(s)) assert.equal(st.on, s.players.filter((p) => p.team === st.team.index && !p.out).length);
    for (const e of s.log) if (e.kind in seen) seen[e.kind]++;
  }
  assert.ok(seen.goal > 0 && seen.save > 0 && seen.snitch > 0, JSON.stringify(seen));
});

test('fouls are from the rulebook and award penalties', () => {
  let fouls = 0;
  for (let seed = 100; seed < 112; seed++) {
    const s = createMatch(seed);
    let penalties = 0;
    while (!s.over) {
      const before = s.phase;
      step(s, 1 / 30);
      s.events.length = 0;
      if (s.phase === 'penalty' && before !== 'penalty') penalties++;
    }
    const called = s.log.filter((e) => e.kind === 'foul');
    for (const e of called) {
      const name = e.parts.find((x) => typeof x === 'string' && x.endsWith('! ') && x !== 'No goal! ');
      assert.ok(Object.keys(FOULS).some((k) => name.toLowerCase().replace(/[^a-z]/g, '').startsWith(k)), name);
    }
    assert.equal(called.length, s.teams[0].fouls + s.teams[1].fouls);
    assert.ok(penalties <= called.length);
    fouls += called.length;
  }
  assert.ok(fouls > 0);
});

test('simulation replays identically from the same seed', () => {
  const run = () => {
    const s = createMatch(1337);
    for (let i = 0; i < 60 * 40; i++) step(s, 1 / 60);
    return [s.players.map((p) => [p.x.toFixed(6), p.y.toFixed(6), p.z.toFixed(6), p.out]), s.teams.map((t) => t.score), s.log.length];
  };
  assert.deepEqual(run(), run());
});
