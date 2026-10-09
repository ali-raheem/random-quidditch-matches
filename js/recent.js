// Recent matches: a short, persisted list of the last few matches watched, each with
// the end-of-match summary and its seed so it can be replayed or shared.
// DOM-free apart from the storage handle, which callers may pass in (tests do).

const KEY = 'rqm.recent';
export const RECENT_MAX = 5;

export function clock(t) {
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The full-time banner summary for a match. `skipped` marks one left before it ended.
export function summarizeMatch(state, { skipped = false } = {}) {
  const teams = state.teams.map((t) => ({ name: t.name, short: t.short, color: t.color, score: t.score }));
  const [a, b] = teams;
  const score = `${a.short} ${a.score} – ${b.score} ${b.short}`;
  if (skipped) {
    return {
      seed: state.seed,
      kicker: 'SKIPPED',
      title: `${a.name} vs ${b.name}`,
      color: null,
      sub: `left at ${clock(state.time)} · ${score}`,
      teams,
    };
  }
  const w = state.winner;
  const parts = [score];
  if (state.catcher) parts.push(`${state.catcher.name} caught the Snitch at ${clock(state.endT)}`);
  else parts.push(`ended by consent at ${clock(state.endT)}`);
  const top = state.players.reduce((best, p) => (p.stats.goals > (best?.stats.goals ?? 0) ? p : best), null);
  if (top) parts.push(`top scorer ${top.name} (${top.stats.goals})`);
  parts.push(state.match.ground);
  return {
    seed: state.seed,
    kicker: state.endReason === 'snitch' ? 'SNITCH CAUGHT' : 'CALLED OFF',
    title: w ? `${w.name} win` : 'A draw',
    color: w?.color ?? null,
    sub: parts.join(' · '),
    teams,
  };
}

// Newest first; a replayed seed moves to the top instead of appearing twice.
export function addRecent(list, entry, max = RECENT_MAX) {
  return [entry, ...list.filter((e) => e.seed !== entry.seed)].slice(0, max);
}

function isValid(e) {
  return e && Number.isInteger(e.seed) && e.seed >= 0 && typeof e.title === 'string' &&
    typeof e.kicker === 'string' && typeof e.sub === 'string' && Array.isArray(e.teams);
}

export function loadRecent(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage.getItem(KEY));
    return Array.isArray(list) ? list.filter(isValid).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function saveRecent(list, storage = globalThis.localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(list));
  } catch { /* storage unavailable; the list just won't survive a reload */ }
}
