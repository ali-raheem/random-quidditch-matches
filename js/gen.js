// Procedural match generation: clubs, kits, crests, line-ups, brooms, tactics, the
// ground and the weather. Pure data, no DOM, driven entirely by the seeded RNG.

import { createRng } from './rng.js';
import { homeSide } from './pitch.js';

// A side is seven: one Keeper, three Chasers, two Beaters and one Seeker.
export const ROLES = ['keeper', 'chaser', 'chaser', 'chaser', 'beater', 'beater', 'seeker'];
export const ROLE_LABEL = { keeper: 'Keeper', chaser: 'Chaser', beater: 'Beater', seeker: 'Seeker' };
// The skill each role is picked for, shown first in the roster.
export const KEY_SKILLS = {
  keeper: ['keeping', 'catching', 'throwing'],
  chaser: ['throwing', 'catching', 'speed'],
  beater: ['power', 'aim', 'agility'],
  seeker: ['vision', 'speed', 'agility'],
};
export const SKILLS = ['speed', 'agility', 'catching', 'throwing', 'power', 'aim', 'keeping', 'vision', 'discipline'];

// Brooms: top speed (ft/s), acceleration (ft/s²) and handling (turn authority, 0–1).
export const BROOMS = [
  { name: 'Driftwood Classic', speed: 60, accel: 48, handling: 0.55 },
  { name: 'Hornbeam 300', speed: 64, accel: 52, handling: 0.6 },
  { name: 'Starling', speed: 66, accel: 60, handling: 0.72 },
  { name: 'Ashwind 7', speed: 70, accel: 56, handling: 0.64 },
  { name: 'Kestrel Pro', speed: 72, accel: 62, handling: 0.7 },
  { name: 'Silverstreak 90', speed: 76, accel: 60, handling: 0.66 },
  { name: 'Gale Runner', speed: 78, accel: 66, handling: 0.6 },
  { name: 'Stormchaser X', speed: 82, accel: 70, handling: 0.74 },
];

export const TACTICS = {
  'Hawkshead Attack': { note: 'Chasers fly in an arrowhead and drive straight at the hoops', arrowhead: true, pass: 0.9, shoot: 1.1, hunt: 0.5, aggression: 1, sitBack: false },
  'Possession Game': { note: 'Short, patient passing until a clear shot opens up', arrowhead: false, pass: 1.5, shoot: 0.8, hunt: 0.5, aggression: 0.8, sitBack: false },
  'Long Ball': { note: 'The Keeper and Chasers throw long to whoever is furthest forward', arrowhead: false, pass: 1.1, shoot: 1.2, hunt: 0.5, aggression: 1, sitBack: false, long: true },
  'Bludger Barrage': { note: 'Both Beaters hunt; the Bludgers are a weapon, not a hazard', arrowhead: false, pass: 1, shoot: 1, hunt: 0.9, aggression: 1.1, sitBack: false },
  'Seeker Screen': { note: 'One Beater shadows the Seeker; win the Snitch, not the Quaffle', arrowhead: false, pass: 1, shoot: 0.9, hunt: 0.2, aggression: 0.9, sitBack: false, screen: true },
  'Rough House': { note: 'Elbows out. Fouls are a price worth paying', arrowhead: false, pass: 0.9, shoot: 1, hunt: 0.7, aggression: 2.2, sitBack: false },
  'Fortress': { note: 'One Chaser sits back to guard the scoring area', arrowhead: false, pass: 1.2, shoot: 0.9, hunt: 0.4, aggression: 0.9, sitBack: true },
};

const TOWN_A = ['Ash', 'Bally', 'Bram', 'Caer', 'Craig', 'Dun', 'Fal', 'Glen', 'Hart', 'Holly', 'Inver', 'Kil', 'Lang', 'Mar', 'Nether', 'Oak', 'Pen', 'Quill', 'Raven', 'Shep', 'Thorn', 'Tre', 'Wig', 'Wolver', 'Yar', 'Bryn', 'Cauld', 'Fen', 'Lud', 'Muir'];
const TOWN_B = ['ford', 'castle', 'wick', 'mouth', 'bury', 'ton', 'more', 'stow', 'combe', 'ley', 'holme', 'gate', 'thwaite', 'mere', 'dale', 'by', 'heath', 'brook', 'well', 'pool'];
// Club nicknames, matched to the town's initial when one fits.
const NICKS = [
  'Arrows', 'Avengers', 'Bats', 'Badgers', 'Bombers', 'Cannons', 'Comets', 'Corsairs', 'Dragons', 'Dynamos',
  'Eagles', 'Falcons', 'Fireflies', 'Furies', 'Gales', 'Griffins', 'Harpies', 'Hawks', 'Hornets', 'Hurricanes',
  'Jackdaws', 'Kestrels', 'Kites', 'Lancers', 'Lightning', 'Magpies', 'Meteors', 'Moths', 'Nightjars', 'Owls',
  'Pelicans', 'Phantoms', 'Pride', 'Ravens', 'Rockets', 'Rovers', 'Sparrows', 'Storm', 'Swifts', 'Thunderers',
  'Tornados', 'Vipers', 'Vultures', 'Wanderers', 'Wasps', 'Wolves', 'Wyverns', 'Yetis', 'Bandits', 'Mariners',
];
const GIVEN = [
  'Aoife', 'Ada', 'Bram', 'Calla', 'Cormac', 'Dilys', 'Emeka', 'Esme', 'Fionn', 'Gwen', 'Hamish', 'Ines', 'Ivo',
  'Jun', 'Kasia', 'Kofi', 'Lars', 'Leilani', 'Mabel', 'Mateo', 'Nia', 'Noor', 'Orla', 'Otto', 'Priya', 'Rafe',
  'Rosalind', 'Sana', 'Seren', 'Tobias', 'Ugo', 'Vesna', 'Wilf', 'Xiomara', 'Yusuf', 'Zelda', 'Bartholomew',
  'Cressida', 'Digby', 'Euan', 'Farah', 'Gideon', 'Hester', 'Idris', 'Juno', 'Kit', 'Lavinia', 'Magnus', 'Oona',
];
const SURNAME = [
  'Abernathy', 'Ashdown', 'Bagshaw', 'Blackwood', 'Brightwater', 'Carrow', 'Chudleigh', 'Croaker', 'Dimmock',
  'Eckersley', 'Fairweather', 'Fenwick', 'Gallagher', 'Grimsditch', 'Hartigan', 'Higginbottom', 'Ironside',
  'Jorkins', 'Kettleburn', 'Larkspur', 'Lowe', 'Mbeki', 'McTavish', 'Nakamura', 'Nightingale', 'Okonkwo',
  'Pennyfeather', 'Quigley', 'Ramsbottom', 'Rowntree', 'Sallow', 'Shacklebolt', 'Silversmith', 'Thistlewood',
  'Tremlett', 'Underhill', 'Vasquez', 'Wainwright', 'Whitlock', 'Wildsmith', 'Yarrow', 'Zabini', 'Kowalczyk',
  'Haddock', 'Moonfield', 'Pucey', 'Stroud', 'Treadwell', 'Bellweather', 'Ogunleye',
];
const GROUNDS = ['Park', 'Moor', 'Fields', 'Downs', 'Heights', 'Common', 'Green', 'Stadium', 'Arena', 'Grounds'];
const OCCASIONS = ['League', 'League', 'League', 'Cup', 'Cup Final', 'Friendly', 'Charity Shield', 'Derby'];
export const CREST_PATTERNS = ['plain', 'pale', 'fess', 'bend', 'chevron', 'quarterly', 'ring', 'saltire'];
export const CREST_GLYPHS = ['wing', 'star', 'bolt', 'moon', 'hoop', 'crown', 'flame', 'ball'];
const SECONDARIES = ['#f4e6b0', '#f4f4f0', '#1c1c24', '#e2b33c', '#c0c6cc'];
export const WEATHERS = ['clear', 'clear', 'sunny', 'overcast', 'wind', 'drizzle', 'rain', 'fog', 'snow'];
export const TIMES = ['day', 'day', 'day', 'evening', 'night'];
const SKIN = ['#f1c9a5', '#e0ac7e', '#c68a5a', '#9a6440', '#6e4630', '#4b3123'];
const HAIR = ['#1d1612', '#3b2618', '#6b3f1d', '#a8682c', '#d8b25a', '#c94f2a', '#e8e0d0', '#5a5450'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function townName(rng) {
  return rng.pick(TOWN_A) + rng.pick(TOWN_B);
}

function clubName(rng, town) {
  const same = NICKS.filter((n) => n[0] === town[0]);
  const nick = same.length && rng.chance(0.7) ? rng.pick(same) : rng.pick(NICKS);
  return `${town} ${nick}`;
}

function makePlayer(rng, team, role, used, quality) {
  // Surnames are unique across the match, so commentary can't mix two players up.
  let given, surname;
  do {
    given = rng.pick(GIVEN);
    surname = rng.pick(SURNAME);
  } while (used.has(surname));
  used.add(surname);
  const name = `${given} ${surname}`;
  const skill = {};
  for (const k of SKILLS) skill[k] = clamp(0.5 + quality + rng.gauss() * 0.4, 0.08, 1);
  for (const k of KEY_SKILLS[role]) skill[k] = clamp(skill[k] * 0.4 + 0.45 + quality + rng.gauss() * 0.22, 0.25, 1);
  return {
    name,
    surname,
    role,
    number: 0,
    skill,
    skin: rng.pick(SKIN),
    hair: rng.pick(HAIR),
  };
}

function makeTeam(rng, index, hue, usedNames, usedTowns) {
  let town;
  do town = townName(rng); while (usedTowns.has(town));
  usedTowns.add(town);
  const tacticKey = rng.pick(Object.keys(TACTICS));
  const quality = rng.range(-0.12, 0.12);
  const broom = BROOMS[clamp(Math.round(rng.range(0, BROOMS.length - 1) + quality * 8), 0, BROOMS.length - 1)];
  const secondary = rng.pick(SECONDARIES);
  const players = ROLES.map((role) => makePlayer(rng, index, role, usedNames, quality));
  const numbers = new Set();
  for (const p of players) {
    do p.number = rng.int(1, 40); while (numbers.has(p.number));
    numbers.add(p.number);
  }
  const captain = rng.pick(players);
  captain.captain = true;
  return {
    index,
    town,
    name: clubName(rng, town),
    short: town,
    tactic: tacticKey,
    quality,
    broom,
    hue,
    color: `hsl(${hue} 68% 52%)`,
    light: `hsl(${hue} 80% 72%)`,
    robe: `hsl(${hue} 62% 40%)`,
    dark: `hsl(${hue} 55% 24%)`,
    secondary,
    crest: { pattern: rng.pick(CREST_PATTERNS), glyph: rng.pick(CREST_GLYPHS) },
    side: homeSide(index),
    players,
    captain: captain.name,
  };
}

export function generateMatch(seed) {
  const rng = createRng(seed);
  const usedNames = new Set();
  const usedTowns = new Set();
  const hue0 = rng.range(0, 360);
  // Kits must be easy to tell apart, so the hues sit at least 110° apart.
  const hue1 = (hue0 + rng.range(110, 250)) % 360;
  const teams = [makeTeam(rng, 0, Math.round(hue0), usedNames, usedTowns), makeTeam(rng, 1, Math.round(hue1), usedNames, usedTowns)];
  const home = rng.int(0, 1);
  const weather = rng.pick(WEATHERS);
  const time = weather === 'sunny' ? 'day' : rng.pick(TIMES);
  const windSpeed = weather === 'wind' ? rng.range(10, 18) : weather === 'fog' ? 0 : rng.range(0, 6);
  const windDir = rng.range(0, Math.PI * 2);
  let surname;
  do surname = rng.pick(SURNAME); while (usedNames.has(surname));
  const referee = `${rng.pick(GIVEN)} ${surname}`;
  return {
    seed,
    teams,
    home,
    ground: `${teams[home].town} ${rng.pick(GROUNDS)}`,
    occasion: rng.pick(OCCASIONS),
    weather,
    time,
    wind: { x: Math.cos(windDir) * windSpeed, y: Math.sin(windDir) * windSpeed, speed: windSpeed },
    referee,
    crowd: rng.range(0.55, 1), // how full the stands are
  };
}
