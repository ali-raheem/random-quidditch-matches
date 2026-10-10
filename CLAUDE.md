# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Random Quidditch Matches: an endless, hands-off procedurally generated Quidditch broadcast under the full rules, shipped as an offline PWA. There is no build step and there are no dependencies. The code is plain ES modules loaded straight from `index.html`. It shares its app shell with Random Space Battles (`../RSB`) and Random Medieval Battles (`../RMB`): the `app.js` loop, panels, `recent.js`, `sw.js` and `bump.mjs` are structurally the same.

(The parent `../CLAUDE.md` describes the shoryuken.me workspace and its shared-origin rules; the one above that, `~/Workspace/CLAUDE.md`, is an unrelated Rust/Fallout project. Ignore that one here.)

## Commands

```bash
npm test                                   # node --test tests/*.test.mjs (~5 s: runs whole matches)
node --test tests/sim.test.mjs             # single test file
node --test --test-name-pattern="replays" tests/*.test.mjs  # single test by name
npm run serve                              # python3 -m http.server 8080 → http://localhost:8080/
npm run bump                               # bump js/version.js patch + BUILT timestamp (-- minor|major)
```

There is no linter or bundler. The page must be served over HTTP, not `file://`, because it uses ES modules and a service worker.

## Architecture

The data flows one way: **seed → gen → sim → (events, log) → render + audio + HUD**, with `app.js` wiring everything together.

- `js/pitch.js`: geometry in feet. x runs along the pitch (hoops at ±`HOOP_X`), y across it, z is altitude. The boundary is a superellipse. `inside(x, y, grow)` and `edgePoint(angle, grow)` take the same `grow` (positive is outside the line). Team 0 defends the −x end and attacks +x (`team.side` / `team.dir`).
- `js/gen.js`: `generateMatch(seed)` creates two clubs (town, nickname, kit, crest, tactic, broom, seven players with role-weighted skills, a captain) plus the ground, occasion, weather, time of day, wind and referee. The tactic table `TACTICS` lives here. Pure data, no DOM.
- `js/sim.js`: `createMatch(seed)` builds the state and `step(state, dt)` advances it.
  - **Phases** (`state.phase`): `lineup` → `release` (Snitch and Bludgers out) → `play`, with `penalty` and `timeout` interludes. `state.over` ends it. `settle()` runs after full time.
  - **Players** set a goal point (`goTo`) in `think()` every ~0.2 s, by role (`thinkChaser`/`holderThink`/`support`/`defend`, `thinkKeeper`, `thinkBeater`, `thinkSeeker`), and `move()` steers towards it every step with accel/speed limits. `p.glide` is a committed dive with no steering (Keeper saves, from `keeperReact()`, which runs every step, not every think).
  - **The Quaffle** (`state.quaffle.flight`): `ref` (in the referee's hand), `held`, `pass`, `shot`, `loose`, `dead` (after a goal or out of bounds, waiting `deadT`) and `feed` (the referee handing it to `receiver`). It falls under a weak gravity (`G_Q`) and drifts in the wind. Goals are detected by the ball crossing a hoop plane inside a ring. Only Chasers and Keepers may catch it (`handles()`).
  - **Bludgers** roam towards a weighted-random nearby player, or fly `struck` for a while after a Beater hits them (`beaterHit()`). Impacts (`bonk()`) daze, drop the Quaffle and sometimes knock out. Players dodge.
  - **The Snitch** darts and hovers. Seekers spot it (more readily as the match goes on, `SPOT_RATE`, `pace`), chase it, and it flees, jinking, faster than a fresh Seeker until it tires (`energy`). `catchSnitch()` ends the match.
  - **Fouls** go through `callFoul()` (only during `play`), which awards a penalty (`startPenalty()`). `refSees()` decides whether the referee notices. The foul list and descriptions are `FOULS`/`FOUL_NAMES`.
  - Commentary goes to `state.log` via `say(state, kind, team, ...parts)`. Parts are strings, player objects or team objects, and the HUD colours players and teams. Wording picks use `state.crng`, a separate stream, so rephrasing commentary never changes play.
- `js/render.js` (`Renderer`) and `js/audio.js` (`SoundEngine`) are presentation only. The renderer projects the world with `P(x, y, z)`, a slight yaw (so the three hoops at each end separate) plus an oblique squash. Draw everything through `P()`, and sort by `depth()`. The pitch and stands are drawn once per match into an offscreen canvas in projected units.
- `js/crest.js`: crest divisions and glyph paths, rendered as SVG in the HUD and as Path2D on the stand banners.
- `js/recent.js`: the recent-matches list (summaries, de-duplication by seed, `localStorage` under `rqm.recent`). Storage is injectable so the module can be tested.
- `js/app.js`: a fixed-timestep loop (`STEP = 1/60`, with a speed multiplier), the scoreboard, the commentary feed, keyboard/button controls, the `#seed=xxxxxxxx` URL hash and match rotation after the full-time banner. The side panels (`roster`, `recent`, `settings`) are registered in the `panels` map and toggled through `showPanel()`/`togglePanel()`.

### Determinism invariants (important)

A match is fully determined by its seed. Reloading the `#seed=` URL has to replay the same match, and the tests check this.

- `gen.js` uses `createRng(seed)`. `sim.js` uses `createRng(seed ^ 0x9e3779b9)` (`state.rng`) for play and `createRng(seed ^ 0x5bd1e995)` (`state.crng`) for commentary wording. Never use `Math.random` in either.
- Iteration order matters: every loop walks `state.players` in index order. Don't introduce order that depends on anything else, and sort with a tiebreak (see `defend()`).
- `render.js` and `audio.js` use `Math.random` on purpose for purely cosmetic effects (the stadium uses its own seeded rng so a replay looks the same). Nothing they do may ever feed back into sim state.
- The sim talks to presentation only through `state.events` and `state.log`. In `app.js` the sound engine ingests events first and the renderer second, and the renderer clears the array.
- Keep the sim step fixed-dt. Results depend on the timestep, and the tests step at 1/30.

## Conventions and gotchas

- **Adding or renaming a file:** add it to `ASSETS` in `sw.js` (`tests/assets.test.mjs` fails otherwise). The cache name comes from `VERSION`, because app.js registers `sw.js?v=<VERSION>`, so run `npm run bump` to force installed copies onto a clean cache.
- **Shared origin:** this app is meant to live on shoryuken.me next to other PWAs (`/rsb/`, `/rmb/` and more). That's why the manifest `id` is `/rqm/index.html` (never change it once installs exist), `localStorage` keys use the `rqm.` prefix, and `sw.js` deletes only caches with its own `rqm-` prefix. Also, `sw.js` handles only requests inside `self.registration.scope`, reads and writes only its own cache (`caches.open(CACHE_NAME)`, never `caches.match()`, which searches every app's caches), precaches with `cache: 'reload'` and fetches with `cache: 'no-cache'` so Cloudflare's 4 h max-age on JS/CSS can't serve stale code after a deploy. All paths are relative, so it works from any subdirectory.
- **Icons:** the UI uses the inline SVG sprite at the top of `index.html` (24×24 `<symbol id="i-…">`, stroked in `currentColor`). Don't use emoji. The PNG app icons are rendered from `icons/icon.svg` with ImageMagick (`convert -background none -density 384 …`), whose SVG renderer ignores `clipPath`, so keep that file clip-free.
- **Touch:** the HUD fades when idle, and the click after a tap that wakes it is swallowed on purpose. Keep control-bar buttons at 38 px or more, and keep the bar within 288 px so it fits on a 320 px phone.
- **Tuning pacing:** match length is mostly `SPOT_RATE`, the `pace` ramp and the opening `blindUntil` in `thinkSeeker()`, plus the Snitch's flee speed and `energy` drain in `updateSnitch()` and the catch chance. Goals are shot speed in `shoot()` versus the Keeper's reaction and dive speed in `keeperReact()` and their reach in `updateQuaffle()`. Knockouts are `KO_BASE` in `bonk()`. Foul rates are spread through `tackle()`, `support()` (stooging lapses), `beaterHit()` (bumphing), `updateQuaffle()` (flacking), `shoot()` (haversacking, Quaffle-pocking) and `updateSnitch()` (snitchnip).
- For balance work, a scratch script that runs ~60 seeds and prints match-length percentiles, goals, saves, fouls by type and knockouts is more informative than the tests. Current targets: median match about 4–5 minutes, p90 under 10, a handful of goals each way, keepers saving roughly half the shots, about 2 fouls and at most about 1 knockout a match, and almost no matches ending by consent.

## Deployment

Live at https://shoryuken.me/rqm/ (`/var/www/shoryuken.me/rqm/`; see the server's `/var/www/shoryuken.me/CLAUDE.md`). After `npm test` and `npm run bump`, ship only the served files:

```bash
rsync -a --delete --chmod=D755,F644 index.html manifest.webmanifest sw.js css js icons root@185.163.204.17:/var/www/shoryuken.me/rqm/
```
