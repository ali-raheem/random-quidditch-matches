import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMatch, addRecent, loadRecent, saveRecent, RECENT_MAX } from '../js/recent.js';
import { createMatch, step } from '../js/sim.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};
const entry = (seed) => ({ seed, kicker: 'SNITCH CAUGHT', title: `t${seed}`, sub: '', color: null, teams: [], at: 0 });

test('keeps the newest five, newest first', () => {
  let list = [];
  for (let s = 1; s <= 8; s++) list = addRecent(list, entry(s));
  assert.equal(list.length, RECENT_MAX);
  assert.deepEqual(list.map((e) => e.seed), [8, 7, 6, 5, 4]);
});

test('a replayed seed moves to the top instead of duplicating', () => {
  let list = [entry(3), entry(2), entry(1)];
  list = addRecent(list, { ...entry(1), kicker: 'CALLED OFF' });
  assert.deepEqual(list.map((e) => e.seed), [1, 3, 2]);
  assert.equal(list[0].kicker, 'CALLED OFF');
});

test('round-trips through storage and ignores junk', () => {
  const store = memStorage();
  saveRecent([entry(10), entry(0xffffffff)], store);
  assert.deepEqual(loadRecent(store).map((e) => e.seed), [10, 0xffffffff]);
  store.setItem('rqm.recent', '[{"seed":"x"},null,' + JSON.stringify(entry(5)) + ']');
  assert.deepEqual(loadRecent(store).map((e) => e.seed), [5]);
  store.setItem('rqm.recent', '{not json');
  assert.deepEqual(loadRecent(store), []);
  assert.deepEqual(loadRecent({ getItem() { throw new Error('denied'); } }), []);
});

test('summaries match the match outcome', () => {
  const s = createMatch(42);
  for (let i = 0; i < 30 * 20; i++) step(s, 1 / 30);
  const skipped = summarizeMatch(s, { skipped: true });
  assert.equal(skipped.kicker, 'SKIPPED');
  assert.equal(skipped.seed, 42);
  assert.match(skipped.sub, /left at 0:20/);

  while (!s.over) step(s, 1 / 30);
  const done = summarizeMatch(s);
  assert.equal(done.seed, 42);
  assert.deepEqual(done.teams.map((t) => t.score), s.teams.map((t) => t.score));
  if (s.winner) {
    assert.equal(done.title, `${s.winner.name} win`);
    assert.equal(done.color, s.winner.color);
  } else {
    assert.equal(done.title, 'A draw');
  }
  if (s.endReason === 'snitch') {
    assert.equal(done.kicker, 'SNITCH CAUGHT');
    assert.match(done.sub, new RegExp(`${s.catcher.name} caught the Snitch`));
  }
  assert.match(done.sub, new RegExp(s.match.ground));
});
