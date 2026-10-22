// Cut the anime city's capture down to the diorama: only the splats inside the
// cut (a disc round the crossing, sliced off above the shopfronts, see
// diorama.json), without the sky floaters, the faint splats or the ones too
// small to see from outside the glass. Written as an .spz like the original, so
// the globe loads a sixth of the city's splats and none of the rest. (Offline,
// dropping the faint and tiny ones left the diorama looking the same.)
//
// Usage: node scripts/crop-city.mjs [in.spz] [out.spz]

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const INPUT = process.argv[2] ?? '../wind/assets/anime-city.spz';
const OUTPUT = process.argv[3] ?? 'assets/diorama.spz';
const CUT = JSON.parse(readFileSync(new URL('../diorama.json', import.meta.url), 'utf8'));

const raw = gunzipSync(readFileSync(INPUT));
if (raw.readUInt32LE(0) !== 0x5053474e) throw new Error('not an SPZ');
const version = raw.readUInt32LE(4);
const count = raw.readUInt32LE(8);
const shDegree = raw[12];
const frac = raw[13];
if (version !== 2 || shDegree !== 0) throw new Error(`expected SPZ v2 without SH, got v${version} SH${shDegree}`);
// v2, no SH: positions (3 × 24-bit), alphas, colours (3), scales (3), rotations (3).
const at = { position: 16, alpha: 16 + count * 9 };
at.colour = at.alpha + count;
at.scale = at.colour + count * 3;
at.rotation = at.scale + count * 3;

const read = (i, k) => {
    const o = at.position + (i * 3 + k) * 3;
    let v = raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    return v / (1 << frac);
};
const colour = (i, k) => 0.5 + 0.282095 * ((raw[at.colour + i * 3 + k] / 255 - 0.5) / 0.15);
const isSky = (i) => {
    const [r, g, b] = [0, 1, 2].map((k) => colour(i, k));
    return b > CUT.sky.blue && b > r + CUT.sky.overRed && b > g + CUT.sky.overGreen;
};

const kept = [];
for (let i = 0; i < count; i++) {
    const x = read(i, 0) - CUT.centre[0];
    const y = read(i, 1);
    const z = read(i, 2) - CUT.centre[1];
    if (x * x + z * z > CUT.radius * CUT.radius || y > CUT.top || y < CUT.base - 1) continue;
    if (raw[at.alpha + i] < CUT.minOpacity || isSky(i)) continue;
    // Too small to see from outside the glass: under a pixel at the globe's distance.
    const largest = Math.max(...[0, 1, 2].map((k) => Math.exp(raw[at.scale + i * 3 + k] / 16 - 10)));
    if (largest < CUT.minSize) continue;
    kept.push(i);
}

const n = kept.length;
const out = Buffer.alloc(16 + n * 9 + n + n * 3 * 3);
raw.copy(out, 0, 0, 16);
out.writeUInt32LE(n, 8);
const to = { position: 16, alpha: 16 + n * 9 };
to.colour = to.alpha + n;
to.scale = to.colour + n * 3;
to.rotation = to.scale + n * 3;
kept.forEach((i, j) => {
    raw.copy(out, to.position + j * 9, at.position + i * 9, at.position + i * 9 + 9);
    out[to.alpha + j] = raw[at.alpha + i];
    raw.copy(out, to.colour + j * 3, at.colour + i * 3, at.colour + i * 3 + 3);
    raw.copy(out, to.scale + j * 3, at.scale + i * 3, at.scale + i * 3 + 3);
    raw.copy(out, to.rotation + j * 3, at.rotation + i * 3, at.rotation + i * 3 + 3);
});
writeFileSync(OUTPUT, gzipSync(out, { level: 9 }));
console.log(`${OUTPUT}: ${n} of ${count} splats (${((n / count) * 100).toFixed(0)}%)`);
