// Pitch geometry, in feet. x runs along the pitch (hoops at each end), y across it,
// z is altitude. The pitch is a rounded oblong (a superellipse), 500 ft by 190 ft,
// with three hoops of different heights at each end. Shared by the sim and renderer.

export const HALF_L = 250;
export const HALF_W = 95;
const N = 4; // superellipse exponent: 2 is an ellipse, higher is boxier

export const HOOP_X = 222; // the hoop plane at each end, ±HOOP_X
export const HOOP_R = 6; // ring radius
// Left to right as seen by a keeper facing the pitch from the +x end.
export const HOOPS = [
  { y: -24, z: 38 },
  { y: 0, z: 50 },
  { y: 24, z: 43 },
];
export const SCORING_X = 172; // the scoring area at each end is |x| > SCORING_X on that side
export const PENALTY_X = 168; // penalty shots are taken from here
export const CENTRE_R = 6; // the centre circle the Quaffle is thrown up from
export const CEILING = 150;
export const FLOOR = 3; // lowest a player flies unless diving for a ground ball

// 1 on the boundary, < 1 inside.
export function boundary(x, y) {
  return (Math.abs(x) / HALF_L) ** N + (Math.abs(y) / HALF_W) ** N;
}

// Inside the boundary grown by `grow` feet (negative shrinks it).
export const inside = (x, y, grow = 0) =>
  boundary((x * HALF_L) / (HALF_L + grow), (y * HALF_W) / (HALF_W + grow)) <= 1;

// The boundary point in direction `a` (radians, 0 = +x).
export function edgePoint(a, grow = 0) {
  const c = Math.cos(a), s = Math.sin(a);
  const r = 1 / ((Math.abs(c) / (HALF_L + grow)) ** N + (Math.abs(s) / (HALF_W + grow)) ** N) ** (1 / N);
  return [c * r, s * r];
}

// Which end a team defends: team 0 the -x hoops, team 1 the +x hoops.
export const homeSide = (team) => (team === 0 ? -1 : 1);
