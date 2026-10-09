// Club crests: a roundel divided in the club's two colours, with a glyph on top.
// Patterns are polygons in the unit square; glyphs are 24×24 SVG paths. The HUD draws
// them as inline SVG and the renderer turns the same paths into Path2D for banners.

export const CREST_SHAPES = {
  plain: [],
  pale: [[[0.5, 0], [1, 0], [1, 1], [0.5, 1]]],
  fess: [[[0, 0.36], [1, 0.36], [1, 0.64], [0, 0.64]]],
  bend: [[[0, 0], [0.3, 0], [1, 0.7], [1, 1], [0.7, 1], [0, 0.3]]],
  chevron: [[[0, 0.75], [0.5, 0.3], [1, 0.75], [1, 1], [0.5, 0.55], [0, 1]]],
  quarterly: [[[0.5, 0], [1, 0], [1, 0.5], [0.5, 0.5]], [[0, 0.5], [0.5, 0.5], [0.5, 1], [0, 1]]],
  ring: [],
  saltire: [[[0, 0], [0.16, 0], [1, 0.84], [1, 1], [0.84, 1], [0, 0.16]], [[1, 0], [1, 0.16], [0.16, 1], [0, 1], [0, 0.84], [0.84, 0]]],
};

export const GLYPHS = {
  wing: 'M3 16c5-1 8-5 10-11 1.5 4 .5 7.5-1.5 9.5 3-1 6.5-.8 9.5.5-3.5 2.2-7.5 3-11.5 2.6 2 .9 4 1.1 6 .9-3.5 2.3-8.5 2.3-12.5-2.5z',
  star: 'M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 16.8 6.4 20.1l1.4-6.3L3 9.5l6.4-.6z',
  bolt: 'M13.5 2L5 13.5h6L9.5 22 19 9.5h-6.2z',
  moon: 'M15 3a9 9 0 1 0 6 13A7 7 0 0 1 15 3z',
  hoop: 'M12 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zm0 2.8a2.7 2.7 0 1 1 0 5.4a2.7 2.7 0 1 1 0-5.4zM10.8 13.2h2.4V22h-2.4z',
  crown: 'M3 18.5h18L19.4 7.5l-4.6 4.2L12 4.5l-2.8 7.2-4.6-4.2z',
  flame: 'M12 2c1 4 6.5 6.2 6.5 12a6.5 6.5 0 0 1-13 0c0-3.2 2-5.4 3.2-7.4 0 2.2 1 3.4 2.3 3.6C11 7 11 4.6 12 2z',
  ball: 'M12 8.6a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 1 0 0-6.8zM1.5 9.5c3.4-1.6 6.6-.4 8.6 2.1-2.3 1.4-5.8 1-8.6-2.1zM22.5 9.5c-3.4-1.6-6.6-.4-8.6 2.1 2.3 1.4 5.8 1 8.6-2.1z',
};

// An inline SVG crest; `uid` keeps clip-path ids unique on the page.
export function crestSvg(team, uid) {
  const { pattern, glyph } = team.crest;
  const id = `crest-${uid}-${team.index}`;
  const sec = team.secondary;
  const polys = CREST_SHAPES[pattern]
    .map((poly) => `<polygon points="${poly.map(([u, v]) => `${u * 24},${v * 24}`).join(' ')}" fill="${sec}" opacity="0.9"/>`)
    .join('');
  const ring = pattern === 'ring' ? `<circle cx="12" cy="12" r="9" fill="none" stroke="${sec}" stroke-width="2.4"/>` : '';
  return `<svg class="crest" viewBox="0 0 24 24" aria-hidden="true">
    <clipPath id="${id}"><circle cx="12" cy="12" r="11.5"/></clipPath>
    <g clip-path="url(#${id})"><rect width="24" height="24" fill="${team.robe}"/>${polys}${ring}</g>
    <g transform="translate(5.4 5.4) scale(0.55)"><path d="${GLYPHS[glyph]}" fill="${sec}" fill-rule="evenodd" stroke="${team.dark}" stroke-width="1.2" paint-order="stroke"/></g>
    <circle cx="12" cy="12" r="11.2" fill="none" stroke="rgba(0,0,0,0.55)" stroke-width="1.1"/></svg>`;
}
