// App wiring: fixed-timestep loop, HUD, controls, match rotation, offline support.

import { createMatch, step, teamStats } from './sim.js';
import { randomSeed } from './rng.js';
import { TACTICS, KEY_SKILLS, ROLE_LABEL } from './gen.js';
import { crestSvg } from './crest.js';
import { Renderer } from './render.js';
import { SoundEngine } from './audio.js';
import { summarizeMatch, addRecent, loadRecent, saveRecent, clock } from './recent.js';
import { VERSION, BUILT } from './version.js';

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 240;
const END_PAUSE = 8; // seconds the full-time banner shows before the next match
const SPEEDS = [0.5, 1, 2, 4];
const NAMES_KEY = 'rqm.names';

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $('view'), hud: $('hud'), teams: $('teams'), matchName: $('match-name'), clock: $('clock'),
  meta: $('meta'), seed: $('seed'), feed: $('feed'), banner: $('banner'),
  pause: $('btn-pause'), speed: $('btn-speed'), next: $('btn-next'),
  roster: $('roster'), recent: $('recent'), settings: $('settings'),
  sound: $('set-sound'), names: $('set-names'), full: $('set-full'), hide: $('set-hide'), install: $('set-install'),
  version: $('version'),
};
// Side panels: at most one is open at a time, toggled by its control-bar button.
const panels = {
  roster: { panel: el.roster, button: $('btn-roster'), onOpen: () => buildRoster() },
  recent: { panel: el.recent, button: $('btn-recent'), onOpen: () => buildRecent() },
  settings: { panel: el.settings, button: $('btn-settings') },
};

const useIcon = (button, name) => button.querySelector('use').setAttribute('href', `#i-${name}`);

const renderer = new Renderer(el.canvas);
const sound = new SoundEngine();
let state = null;
let paused = false;
let speedIndex = 1;
let acc = 0;
let endTimer = 0;
let hudTimer = 0;
let rosterTimer = 0;
let feedSeen = 0;
let shownScores = [];
let recent = loadRecent();

try {
  renderer.showNames = localStorage.getItem(NAMES_KEY) !== 'off';
} catch { /* storage unavailable; default on */ }

function seedFromHash(hash = location.hash) {
  const m = hash.match(/seed=([0-9a-f]+)/i);
  return m ? parseInt(m[1], 16) >>> 0 : null;
}

function hex(seed) {
  return seed.toString(16).padStart(8, '0');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function newMatch(seed = randomSeed()) {
  // Log a match that's being left unfinished, as long as it was actually watched.
  if (state && !state.over && state.time > 5) remember(summarizeMatch(state, { skipped: true }));
  state = createMatch(seed);
  acc = 0;
  endTimer = 0;
  feedSeen = 0;
  shownScores = state.teams.map(() => 0);
  renderer.reset(state);
  sound.setWeather(state.match);
  history.replaceState(null, '', `#seed=${hex(seed)}`);
  const m = state.match;
  el.matchName.textContent = `${m.occasion} at ${m.ground}`;
  el.matchName.title = `${weatherText(m)}. Referee: ${m.referee}`;
  el.seed.textContent = `seed ${hex(seed)}`;
  el.feed.replaceChildren();
  el.banner.hidden = true;
  buildTeams();
  buildRoster();
  updateHud();
  placePanels();
}

function weatherText(m) {
  const w = { clear: 'Clear skies', sunny: 'Bright sunshine', overcast: 'Overcast', wind: 'A strong wind', drizzle: 'Drizzle', rain: 'Driving rain', fog: 'Thick fog', snow: 'Snow' }[m.weather];
  const t = { day: '', evening: ', evening', night: ', under lanterns' }[m.time];
  return `${w}${t}`;
}

// Panels open just below the scoreboard, whose height depends on the width.
function placePanels() {
  el.hud.style.setProperty('--hud-top', `${Math.ceil(el.meta.getBoundingClientRect().bottom) + 10}px`);
}

// --- HUD ---------------------------------------------------------------------------

function buildTeams() {
  el.teams.innerHTML = state.teams.map((t) => `
    <div class="team" style="--c:${t.color}" data-team="${t.index}">
      <div class="name" title="${escapeHtml(t.name)}">${crestSvg(t, 'h')}<span>${escapeHtml(t.name)}</span><span class="score">0</span></div>
      <div class="sub"><span>${escapeHtml(t.tactic)}</span><span class="count"></span></div>
    </div>`).join('');
}

function partHtml(x) {
  if (typeof x === 'string') return escapeHtml(x);
  if (x && 'role' in x) return `<span class="p" style="color:${state.teams[x.team].light}">${escapeHtml(x.name)}</span>`;
  if (x && 'town' in x) return `<span class="p" style="color:${x.light}">${escapeHtml(x.name)}</span>`;
  return '';
}

function updateHud() {
  for (const s of teamStats(state)) {
    const node = el.teams.querySelector(`[data-team="${s.team.index}"]`);
    const score = node.querySelector('.score');
    if (shownScores[s.team.index] !== s.score) {
      shownScores[s.team.index] = s.score;
      score.textContent = s.score;
      score.classList.remove('bump');
      void score.offsetWidth; // restart the animation
      score.classList.add('bump');
    }
    node.querySelector('.count').textContent = `${s.on} on brooms${s.fouls ? ` · ${s.fouls} foul${s.fouls > 1 ? 's' : ''}` : ''}`;
  }
  el.clock.textContent = clock(state.time);

  while (feedSeen < state.log.length) {
    const e = state.log[feedSeen++];
    const li = document.createElement('li');
    if (e.team === null || e.team === undefined) li.classList.add('neutral');
    else li.style.setProperty('--c', state.teams[e.team].color);
    if (e.kind === 'goal' || e.kind === 'snitch' || e.kind === 'ko') li.classList.add('big');
    li.innerHTML = e.parts.map(partHtml).join('');
    el.feed.append(li);
    while (el.feed.children.length > 6) el.feed.firstElementChild.remove();
  }
}

function showBanner() {
  const s = summarizeMatch(state);
  el.banner.style.setProperty('--c', s.color ?? '#f1ead8');
  el.banner.querySelector('.kicker').textContent = s.kicker;
  el.banner.querySelector('.title').textContent = s.title;
  el.banner.querySelector('.sub').textContent = s.sub;
  el.banner.hidden = false;
  remember(s);
}

// --- recent matches ----------------------------------------------------------------

function seedUrl(seed) {
  return `${location.origin}${location.pathname}#seed=${hex(seed)}`;
}

function remember(summary) {
  recent = addRecent(recent, { ...summary, at: Date.now() });
  saveRecent(recent);
  if (!el.recent.hidden) buildRecent();
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function buildRecent() {
  if (!recent.length) {
    el.recent.innerHTML = '<h2>Recent matches</h2><p class="empty">Matches you watch will appear here, so you can replay or share them.</p>';
    return;
  }
  el.recent.innerHTML = '<h2>Recent matches</h2>' + recent.map((e) => `
    <article class="past${e.kicker === 'SKIPPED' ? ' skipped' : ''}" style="--c:${e.color ?? '#f1ead8'}">
      <div class="kicker">${escapeHtml(e.kicker)} · ${ago(e.at)}</div>
      <div class="title">${escapeHtml(e.title)}</div>
      ${e.kicker === 'SKIPPED' ? '' : `<div class="vs">${e.teams.map((t) => `<span style="color:${t.color}">${escapeHtml(t.name)} ${Number(t.score) || 0}</span>`).join(' – ')}</div>`}
      <div class="sub">${escapeHtml(e.sub)}</div>
      <div class="actions">
        <button data-replay="${e.seed}"><svg class="icon"><use href="#i-play"/></svg>Replay</button>
        <button data-copy="${e.seed}"><svg class="icon"><use href="#i-link"/></svg><span>Copy link</span></button>
        <a href="#seed=${hex(e.seed)}" class="seed-link">seed ${hex(e.seed)}</a>
      </div>
    </article>`).join('');
}

async function copyText(button, text) {
  const target = button.querySelector('span') ?? button;
  const label = target.textContent;
  try {
    await navigator.clipboard.writeText(text);
    target.textContent = 'Link copied';
  } catch {
    target.textContent = 'Copy failed';
  }
  setTimeout(() => (target.textContent = label), 1200);
}

el.recent.addEventListener('click', (e) => {
  const replay = e.target.closest('[data-replay]');
  const copy = e.target.closest('[data-copy]');
  const link = e.target.closest('.seed-link');
  if (replay) newMatch(Number(replay.dataset.replay));
  else if (copy) copyText(copy, seedUrl(Number(copy.dataset.copy)));
  else if (link) {
    e.preventDefault();
    newMatch(seedFromHash(link.getAttribute('href')) ?? state.seed);
  }
});

// --- line-ups ------------------------------------------------------------------------

function playerLine(p) {
  const s = p.stats;
  const bits = [];
  if (p.role === 'chaser') bits.push(`${s.goals} goal${s.goals === 1 ? '' : 's'}`, `${s.shots} shot${s.shots === 1 ? '' : 's'}`);
  if (p.role === 'keeper') bits.push(`${s.saves} save${s.saves === 1 ? '' : 's'}`);
  if (p.role === 'beater') bits.push(`${s.hits} hit${s.hits === 1 ? '' : 's'}`);
  if (p.role === 'seeker') bits.push(state.snitch.holder === p ? 'caught it!' : p.mode === 'chase' ? 'chasing' : 'searching');
  if (s.fouls) bits.push(`${s.fouls} foul${s.fouls > 1 ? 's' : ''}`);
  if (p.out) bits.unshift('OUT');
  return bits.join(' · ');
}

function buildRoster() {
  el.roster.innerHTML = state.teams.map((t) => {
    const tac = TACTICS[t.tactic];
    const rows = state.players.filter((p) => p.team === t.index).map((p) => `
      <div class="pl${p.out ? ' out' : ''}">
        <span class="num">${p.number}</span>
        <span class="who"><b>${escapeHtml(p.name)}</b>${p.captain ? ' (c)' : ''} <span class="kind">${ROLE_LABEL[p.role]}</span></span>
        <span class="stats">${escapeHtml(playerLine(p))}</span>
        <span class="skills">${KEY_SKILLS[p.role].map((k) => `<span>${k}<i><b style="width:${Math.round(p.skill[k] * 100)}%"></b></i></span>`).join('')}</span>
      </div>`).join('');
    return `
      <section style="--c:${t.color}">
        <h2>${crestSvg(t, 'r')}${escapeHtml(t.name)}</h2>
        <div class="tech"><b>${escapeHtml(t.tactic)}</b>: ${escapeHtml(tac.note)}.<br>
          Brooms: ${escapeHtml(t.broom.name)} · top speed ${t.broom.speed} ft/s</div>
        ${rows}
      </section>`;
  }).join('');
}

// --- loop --------------------------------------------------------------------------

let last = performance.now();
function frame(now) {
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let simDt = 0;
  if (!paused) {
    acc += realDt * SPEEDS[speedIndex];
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS_PER_FRAME) {
      step(state, STEP);
      sound.ingest(state.events, renderer, state);
      renderer.ingest(state.events);
      acc -= STEP;
      simDt += STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) acc = 0;

    if (state.over) {
      if (endTimer === 0) {
        updateHud();
        showBanner();
        sound.fanfare();
      }
      endTimer += realDt;
      if (endTimer > END_PAUSE) newMatch();
    }
  }
  renderer.update(state, simDt, realDt);
  renderer.draw(state);

  hudTimer -= realDt;
  if (hudTimer <= 0) {
    updateHud();
    hudTimer = 0.2;
  }
  rosterTimer -= realDt;
  if (rosterTimer <= 0 && !el.roster.hidden) {
    buildRoster();
    rosterTimer = 1;
  }
  requestAnimationFrame(frame);
}

// --- controls ----------------------------------------------------------------------

function setPaused(p) {
  paused = p;
  sound.setPaused(p);
  useIcon(el.pause, paused ? 'play' : 'pause');
  el.pause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
  el.pause.setAttribute('aria-pressed', String(paused));
}
function changeSpeed(delta) {
  speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, speedIndex + delta));
  el.speed.textContent = `${SPEEDS[speedIndex]}×`;
}
function cycleSpeed() {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  changeSpeed(0);
}
// Opens the named panel and closes the rest; null closes them all.
function showPanel(name) {
  for (const [key, p] of Object.entries(panels)) {
    p.panel.hidden = key !== name;
    p.button.setAttribute('aria-pressed', String(key === name));
  }
  if (name) panels[name].onOpen?.();
}
const togglePanel = (name) => showPanel(panels[name].panel.hidden ? name : null);
const anyPanelOpen = () => Object.values(panels).some((p) => !p.panel.hidden);

function setSwitch(row, on) {
  row.setAttribute('aria-checked', String(on));
}
function toggleNames() {
  renderer.showNames = !renderer.showNames;
  setSwitch(el.names, renderer.showNames);
  try {
    localStorage.setItem(NAMES_KEY, renderer.showNames ? 'on' : 'off');
  } catch { /* storage unavailable; preference just won't persist */ }
}
function renderSound() {
  setSwitch(el.sound, sound.enabled);
  useIcon(el.sound, sound.enabled ? 'sound' : 'sound-off');
}
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  sound.setWeather(state.match);
  renderSound();
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
function setHudHidden(hidden) {
  el.hud.classList.toggle('hidden', hidden);
}

el.pause.addEventListener('click', () => setPaused(!paused));
el.speed.addEventListener('click', cycleSpeed);
el.next.addEventListener('click', () => newMatch());
for (const [name, p] of Object.entries(panels)) p.button.addEventListener('click', () => togglePanel(name));
el.sound.addEventListener('click', toggleSound);
el.names.addEventListener('click', toggleNames);
el.full.addEventListener('click', toggleFullscreen);
el.hide.addEventListener('click', () => {
  showPanel(null);
  setHudHidden(true);
});
el.seed.addEventListener('click', () => copyText(el.seed, seedUrl(state.seed)));
document.addEventListener('fullscreenchange', () => setSwitch(el.full, !!document.fullscreenElement));
// iPhone Safari has no element fullscreen; "Add to Home Screen" is the way there.
el.full.hidden = !document.documentElement.requestFullscreen;
renderSound();
setSwitch(el.names, renderer.showNames);
setSwitch(el.full, false);
el.version.textContent = `v${VERSION} · built ${new Date(BUILT).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
el.version.title = BUILT;

// Install: Chromium browsers hand us a deferred prompt; iOS Safari has no install API,
// so there the row explains Share → Add to Home Screen instead. Elsewhere (Firefox
// desktop) there's no way to install, so the row stays hidden, as it does once the
// app is running installed. Checked once at startup: in Chrome, display-mode
// "fullscreen" also matches while a tab is in element fullscreen.
let installPrompt = null;
const runningInstalled = navigator.standalone === true ||
  matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function renderInstall() {
  const hint = el.install.querySelector('small');
  if (installPrompt) hint.textContent = 'adds it to your home screen or desktop; works offline';
  else if (isIOS) hint.textContent = 'in Safari, tap Share, then Add to Home Screen';
  el.install.hidden = runningInstalled || (!installPrompt && !isIOS);
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  renderInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  el.install.hidden = true;
});
el.install.addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null; // a prompt can only be shown once
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === 'accepted') el.install.hidden = true;
  else renderInstall();
});
renderInstall();

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case ' ': setPaused(!paused); break;
    case 'n': case 'N': newMatch(); break;
    case '+': case '=': changeSpeed(1); break;
    case '-': case '_': changeSpeed(-1); break;
    case 'r': case 'R': togglePanel('roster'); break;
    case 'l': case 'L': togglePanel('recent'); break;
    case 's': case 'S': togglePanel('settings'); break;
    case 't': case 'T': toggleNames(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'm': case 'M': toggleSound(); break;
    case 'h': case 'H': setHudHidden(!el.hud.classList.contains('hidden')); break;
    case 'Escape': if (!anyPanelOpen()) return; showPanel(null); break;
    default: return;
  }
  e.preventDefault();
  wakeHud();
});

// Auto-hide the controls after a few idle seconds so it works as a screensaver. A tap
// while they're hidden only brings them back; it must not press the invisible button
// underneath, so the click that follows it is swallowed.
let idleTimer = null;
let swallowClick = false;
function wakeHud() {
  el.hud.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!anyPanelOpen()) el.hud.classList.add('idle');
  }, 4000);
}
window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wakeHud(); });
window.addEventListener('pointerdown', () => {
  swallowClick = el.hud.classList.contains('idle') || el.hud.classList.contains('hidden');
  setHudHidden(false);
  wakeHud();
}, { capture: true });
window.addEventListener('click', (e) => {
  if (swallowClick) {
    e.preventDefault();
    e.stopPropagation();
  }
  swallowClick = false;
}, { capture: true });

// Audio can only start after a user gesture; the first click/tap/key unlocks it.
for (const type of ['pointerdown', 'keydown', 'touchend']) {
  window.addEventListener(type, () => {
    const fresh = !sound.ctx;
    sound.unlock();
    if (fresh && sound.ctx) sound.setWeather(state.match);
  }, { capture: true });
}

window.addEventListener('resize', () => {
  renderer.resize();
  placePanels();
});
window.addEventListener('hashchange', () => {
  const seed = seedFromHash();
  if (seed !== null && seed !== state.seed) newMatch(seed);
});

// Keep the screen awake while the tab is visible.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* not allowed; fine */ }
}
document.addEventListener('visibilitychange', () => {
  sound.setPaused(document.visibilityState !== 'visible' || paused);
  if (document.visibilityState === 'visible') {
    last = performance.now();
    if (!wakeLock || wakeLock.released) requestWakeLock();
  }
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register(`./sw.js?v=${VERSION}`).catch(() => {});
}

newMatch(seedFromHash() ?? randomSeed());
wakeHud();
requestWakeLock();
requestAnimationFrame(frame);
