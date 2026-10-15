/**
 * The fire as a simulation, on WebGPU compute: a small grid of air over the fire
 * pit, and flame, smoke and ember particles that ride it.
 *
 * The grid is "stable fluids" (Stam): each frame the air is carried along by its
 * own motion (semi-Lagrangian advection), heated by the coals and lifted by its
 * temperature (buoyancy), spun up where it already swirls (vorticity confinement),
 * and made incompressible (a Jacobi pressure solve), so hot gas has to shoulder
 * cold air aside and rolls as it climbs. It carries a temperature and a smoke
 * density along with it.
 *
 * The particles don't make the fire's shape: the grid does. A flame particle is
 * bright only where the gas it sits in is hot, so the flame is the grid's hot
 * region, seen through particles that trace its flow. Smoke particles show the
 * grid's smoke density. Embers have weight: they're dragged along by the air but
 * fall back out of it, land, and glow on the ground until they cool.
 *
 * Everything persists between frames on the GPU; the CPU only sets a few uniforms
 * and submits one batch of dispatches a frame. WebGPU only: the WebGL2 backend
 * keeps the stateless particles (flame.ts, smoke.ts, embers.ts).
 *
 * Sections: settings · grid · fluid kernels · particles · flame · smoke · embers ·
 * the frame.
 */

import {
    GpuSplats,
    SplatCollection,
    type SplatObject,
    TSL,
    type TslNode,
    WgpuBuffer,
    WgpuCompute,
    WgpuComputeBatch,
} from 'spark-radix';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { type Fire, fireHeat } from './fire';
import { FLAME_ORIGIN } from './scene';
import { flameAlignY, flameCurl, v3 } from './tsl';

const {
    If,
    clamp,
    cos,
    atan,
    cross,
    dot,
    exp,
    float,
    floor,
    hash,
    int,
    length,
    max,
    min,
    mix,
    normalize,
    pow,
    select,
    sin,
    smoothstep,
    sqrt,
    uint,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

/* settings */

/** Cells along x, y, z, and a cell's size in metres: a 2.4 × 5.8 × 2.4 m column. */
const RES = [40, 96, 40] as const;
const CELL = 0.06;
/** How far the grid reaches below the fire's origin. */
const BELOW = 0.35;
const JACOBI_ITERATIONS = 24;

const AIR = {
    /** Upward acceleration per unit of temperature, m/s², and the drag of smoke's weight. */
    buoyancy: 3.0,
    smokeWeight: 0.4,
    /** Per second: how fast hot gas cools, and smoke thins. Cooling sets the flames' height. */
    cooling: 3.4,
    smokeFade: 0.25,
    /** How much smoke cooling flame gas leaves behind, per unit of temperature per second. */
    soot: 0.35,
    /** Vorticity confinement: how hard existing swirls are spun up. */
    vorticity: 1.2,
    /** The prevailing breeze, m/s, and how strongly air above the fire is pulled toward it. */
    breeze: [0.22, 0, -0.1],
    breezePull: 0.25,
    /** How much of the ambient gusting (air.ts) reaches the fire. */
    gusts: 0.4,
} as const;

const COALS = {
    radius: 0.5,
    /** The burning layer's thickness above the origin. */
    depth: 0.16,
    /** Temperature added per second at full burn, and the cap. */
    heating: 10,
    maxTemperature: 1.3,
    /** Upward push where it burns, m/s². */
    lift: 3,
    /** A dim, even burn across the whole bed, under the flames. */
    embers: 0.12,
} as const;

/**
 * Where the bed burns: a slowly drifting noise field over the logs. Patches of it
 * are alight and patches are not, and they move continuously, so tongues form
 * where the hot patches are and wander with them rather than switching on and off.
 * The same field feeds the grid's heat and seeds the flame particles.
 */
const BED = {
    /** How dark the unlit patches are: 1 leaves them cold, 0 burns evenly. */
    unevenness: 0.82,
} as const;

/* grid */

const CELLS = RES[0] * RES[1] * RES[2];
const [RX, RY, RZ] = RES;
const ORIGIN = new THREE.Vector3(...FLAME_ORIGIN);
/** The world position of the grid's (0, 0, 0) corner. */
const GRID_MIN = new THREE.Vector3((-RX * CELL) / 2, -BELOW, (-RZ * CELL) / 2).add(ORIGIN);
const gridMin = vec3(GRID_MIN.x, GRID_MIN.y, GRID_MIN.z);

/** A cell's linear index from integer coordinates, clamped to the grid. */
function cellAt(x: TslNode, y: TslNode, z: TslNode): TslNode {
    const cx = clamp(x, int(0), int(RX - 1));
    const cy = clamp(y, int(0), int(RY - 1));
    const cz = clamp(z, int(0), int(RZ - 1));
    return cx.add(cy.mul(int(RX))).add(cz.mul(int(RX * RY)));
}

/** A thread's cell coordinates, as ints. */
function cellOf(index: TslNode) {
    const i = int(index);
    return { x: i.mod(int(RX)), y: i.div(int(RX)).mod(int(RY)), z: i.div(int(RX * RY)) };
}

/** World metres to continuous cell coordinates (cell centres at whole + 0.5). */
function toCells(world: TslNode): TslNode {
    return world.sub(gridMin).div(CELL);
}

/** How hard the bed burns at world xz right now, 0..1: the hot patches, within a wavering footprint. */
function bedBurn(xz: TslNode, time: TslNode, heat: TslNode): TslNode {
    const rel = xz.sub(v3(FLAME_ORIGIN).xz).toVar();
    const bedRadius = length(rel).toVar();
    const bedAngle = atan(rel.y, rel.x);
    const bedNoise = sin(dot(xz, vec2(19, 13)).add(time.mul(0.8)))
        .add(sin(dot(xz, vec2(-11, 27)).add(time.mul(0.55)).add(2.1)).mul(0.7))
        .add(sin(dot(xz, vec2(33, -21)).sub(time.mul(1.1)).add(4.3)).mul(0.5))
        .div(2.2);
    const patchAlight = smoothstep(-0.5, 0.5, bedNoise.add(heat.sub(0.45).mul(1.3)));
    const footprint = sin(bedAngle.mul(3).add(time.mul(0.25)))
        .mul(0.35)
        .add(0.75)
        .add(sin(bedAngle.mul(5).sub(time.mul(0.17)).add(1.3)).mul(0.2));
    const edgeFalloff = min(bedRadius.div(footprint.mul(COALS.radius)), 1)
        .mul(0.4)
        .oneMinus();
    const rim = smoothstep(COALS.radius * 0.85, COALS.radius * 1.15, bedRadius).oneMinus();
    return patchAlight.oneMinus().mul(BED.unevenness).oneMinus().mul(edgeFalloff).mul(rim);
}

/** A vec4 grid buffer sampled trilinearly at continuous cell coordinates. */
function sampleGrid(buffer: WgpuBuffer<'float32x4'>, cells: TslNode): TslNode {
    const p = cells.sub(0.5).toVar();
    const base = floor(p).toVar();
    const f = p.sub(base).toVar();
    const x = int(base.x).toVar();
    const y = int(base.y).toVar();
    const z = int(base.z).toVar();
    const at = (dx: number, dy: number, dz: number) => buffer.element(cellAt(x.add(int(dx)), y.add(int(dy)), z.add(int(dz))));
    const zy0 = mix(mix(at(0, 0, 0), at(1, 0, 0), f.x), mix(at(0, 1, 0), at(1, 1, 0), f.x), f.y);
    const zy1 = mix(mix(at(0, 0, 1), at(1, 0, 1), f.x), mix(at(0, 1, 1), at(1, 1, 1), f.x), f.y);
    return mix(zy0, zy1, f.z);
}

/* fluid kernels */

type Grid = {
    /** Velocity, m/s (xyz). A is the state between frames; B is the step's working copy. */
    velA: WgpuBuffer<'float32x4'>;
    velB: WgpuBuffer<'float32x4'>;
    /** x: temperature (0 cold, ~1 flame), y: smoke density. */
    airA: WgpuBuffer<'float32x4'>;
    airB: WgpuBuffer<'float32x4'>;
    /** Vorticity (xyz) and its magnitude (w). */
    curl: WgpuBuffer<'float32x4'>;
    divergence: WgpuBuffer<'float32'>;
    pressureA: WgpuBuffer<'float32'>;
    pressureB: WgpuBuffer<'float32'>;
};

type FrameUniforms = {
    dt: TslNode;
    time: TslNode;
    /** The fire's heat, 0..1, and its stoke flare. */
    heat: TslNode;
    pulse: TslNode;
    /** Gusts on top of the breeze, world xz in xz. */
    wind: TslNode;
    /** Counts frames, to reseed respawns. */
    frame: TslNode;
};

function makeGrid(renderer: WebGPURenderer): Grid {
    const vec4s = () => new WgpuBuffer({ renderer, format: 'float32x4', count: CELLS });
    const floats = () => new WgpuBuffer({ renderer, format: 'float32', count: CELLS });
    return {
        velA: vec4s(),
        velB: vec4s(),
        airA: vec4s(),
        airB: vec4s(),
        curl: vec4s(),
        divergence: floats(),
        pressureA: floats(),
        pressureB: floats(),
    };
}

/** Each cell, guarded: a dispatch rounds up to whole workgroups. */
function perCell(label: string, body: (cell: ReturnType<typeof cellOf>, index: TslNode) => void): WgpuCompute {
    return new WgpuCompute({
        label,
        body: ({ index }) => {
            If(index.lessThan(uint(CELLS)), () => body(cellOf(index), index));
        },
    });
}

/**
 * Advect velocity and air from A into B, then add this step's forces and sources:
 * buoyancy, the coals' heat and lift, cooling into smoke, and the breeze.
 */
function makeAdvect(grid: Grid, u: FrameUniforms): WgpuCompute {
    return perCell('fireAdvect', ({ x, y, z }, index) => {
        const centre = vec3(float(x), float(y), float(z)).add(0.5).toVar();
        const world = gridMin.add(centre.mul(CELL)).toVar();
        const velocity = grid.velA.element(index).xyz;
        const from = centre.sub(velocity.mul(u.dt.div(CELL)));

        const v = sampleGrid(grid.velA, from).xyz.toVar();
        const air = sampleGrid(grid.airA, from).toVar();
        const temperature = air.x.toVar();
        const smoke = air.y.toVar();

        // The coals: a dim, even bed, and the hot patches burning hard on it.
        const rel = world.sub(v3(FLAME_ORIGIN)).toVar();
        const layer = smoothstep(-0.12, 0.0, rel.y)
            .mul(smoothstep(COALS.depth * 0.4, COALS.depth, rel.y).oneMinus())
            .toVar();
        const inBed = smoothstep(COALS.radius * 0.6, COALS.radius, length(rel.xz)).oneMinus();
        const burning = bedBurn(world.xz, u.time, u.heat).mul(u.heat.mul(0.9).add(0.5));
        const burn = burning.add(inBed.mul(COALS.embers)).mul(layer).toVar();

        temperature.assign(min(temperature.add(burn.mul(COALS.heating).mul(u.dt)), COALS.maxTemperature));
        // Cooling gas leaves smoke behind; the smoke itself slowly thins.
        const cooled = temperature.mul(exp(u.dt.mul(-AIR.cooling))).toVar();
        smoke.assign(smoke.add(temperature.sub(cooled).mul(AIR.soot / AIR.cooling)).mul(exp(u.dt.mul(-AIR.smokeFade))));
        temperature.assign(cooled);

        // Hot gas rises, smoke is heavy, and the coals push up.
        v.y.addAssign(temperature.mul(AIR.buoyancy).sub(smoke.mul(AIR.smokeWeight)).add(burn.mul(COALS.lift)).mul(u.dt));

        // Above the pit, the breeze takes over.
        const exposed = smoothstep(0.4, 2.5, rel.y);
        const breeze = v3(AIR.breeze).add(u.wind);
        v.xz.addAssign(breeze.xz.sub(v.xz).mul(exposed.mul(AIR.breezePull).mul(u.dt)));

        grid.velB.element(index).assign(vec4(v, 0));
        grid.airB.element(index).assign(vec4(temperature, smoke, 0, 0));
    });
}

/** Central differences of a vec4 field at a cell. */
function neighbours(buffer: WgpuBuffer<'float32x4'>, x: TslNode, y: TslNode, z: TslNode) {
    return {
        px: buffer.element(cellAt(x.add(int(1)), y, z)),
        nx: buffer.element(cellAt(x.sub(int(1)), y, z)),
        py: buffer.element(cellAt(x, y.add(int(1)), z)),
        ny: buffer.element(cellAt(x, y.sub(int(1)), z)),
        pz: buffer.element(cellAt(x, y, z.add(int(1)))),
        nz: buffer.element(cellAt(x, y, z.sub(int(1)))),
    };
}

function makeCurl(grid: Grid): WgpuCompute {
    return perCell('fireCurl', ({ x, y, z }, index) => {
        const n = neighbours(grid.velB, x, y, z);
        const w = vec3(
            n.py.z.sub(n.ny.z).sub(n.pz.y.sub(n.nz.y)),
            n.pz.x.sub(n.nz.x).sub(n.px.z.sub(n.nx.z)),
            n.px.y.sub(n.nx.y).sub(n.py.x.sub(n.ny.x)),
        )
            .div(2 * CELL)
            .toVar();
        grid.curl.element(index).assign(vec4(w, length(w)));
    });
}

/** Spin up existing swirls: push along N × ω, N pointing up the vorticity's gradient. */
function makeConfine(grid: Grid, u: FrameUniforms): WgpuCompute {
    return perCell('fireConfine', ({ x, y, z }, index) => {
        const n = neighbours(grid.curl, x, y, z);
        const gradient = vec3(n.px.w.sub(n.nx.w), n.py.w.sub(n.ny.w), n.pz.w.sub(n.nz.w)).toVar();
        const towardSwirl = gradient.div(max(length(gradient), 1e-5));
        const force = cross(towardSwirl, grid.curl.element(index).xyz).mul(AIR.vorticity * CELL);
        const v = grid.velB.element(index);
        v.assign(vec4(v.xyz.add(force.mul(u.dt)), 0));
    });
}

function makeDivergence(grid: Grid): WgpuCompute {
    return perCell('fireDivergence', ({ x, y, z }, index) => {
        const n = neighbours(grid.velB, x, y, z);
        grid.divergence.element(index).assign(
            n.px.x
                .sub(n.nx.x)
                .add(n.py.y.sub(n.ny.y))
                .add(n.pz.z.sub(n.nz.z))
                .div(2 * CELL),
        );
    });
}

/**
 * One Jacobi iteration of the pressure Poisson equation, from one buffer into the
 * other. The floor is closed (pressure mirrors across it); the sides and top are
 * open air (pressure 0 beyond them), so gas can leave the grid.
 */
function makeJacobi(grid: Grid, from: WgpuBuffer<'float32'>, to: WgpuBuffer<'float32'>, label: string): WgpuCompute {
    return perCell(label, ({ x, y, z }, index) => {
        const open = (px: TslNode, py: TslNode, pz: TslNode) => {
            const outside = px
                .lessThan(int(0))
                .or(px.greaterThan(int(RX - 1)))
                .or(pz.lessThan(int(0)))
                .or(pz.greaterThan(int(RZ - 1)))
                .or(py.greaterThan(int(RY - 1)));
            return select(outside, float(0), from.element(cellAt(px, py, pz)));
        };
        const sum = open(x.add(int(1)), y, z)
            .add(open(x.sub(int(1)), y, z))
            .add(open(x, y.add(int(1)), z))
            .add(open(x, y.sub(int(1)), z))
            .add(open(x, y, z.add(int(1))))
            .add(open(x, y, z.sub(int(1))));
        to.element(index).assign(sum.sub(grid.divergence.element(index).mul(CELL * CELL)).div(6));
    });
}

/** Subtract the pressure gradient into A, close the floor, and carry the air over. */
function makeProject(grid: Grid): WgpuCompute {
    return perCell('fireProject', ({ x, y, z }, index) => {
        const p = grid.pressureA;
        const open = (px: TslNode, py: TslNode, pz: TslNode) => {
            const outside = px
                .lessThan(int(0))
                .or(px.greaterThan(int(RX - 1)))
                .or(pz.lessThan(int(0)))
                .or(pz.greaterThan(int(RZ - 1)))
                .or(py.greaterThan(int(RY - 1)));
            return select(outside, float(0), p.element(cellAt(px, py, pz)));
        };
        const gradient = vec3(
            open(x.add(int(1)), y, z).sub(open(x.sub(int(1)), y, z)),
            open(x, y.add(int(1)), z).sub(open(x, y.sub(int(1)), z)),
            open(x, y, z.add(int(1))).sub(open(x, y, z.sub(int(1)))),
        ).div(2 * CELL);
        const v = grid.velB.element(index).xyz.sub(gradient).toVar();
        If(y.equal(int(0)), () => {
            v.y.assign(max(v.y, 0));
        });
        grid.velA.element(index).assign(vec4(v, 0));
        grid.airA.element(index).assign(grid.airB.element(index));
    });
}

/* particles */

/**
 * A particle system's state on the GPU: `pos` (xyz world, w age in seconds), `vel`
 * (xyz m/s, w a value sampled for drawing) and `meta` (x lifetime, y generation,
 * z, w per-kind).
 */
type Particles = {
    count: number;
    pos: WgpuBuffer<'float32x4'>;
    vel: WgpuBuffer<'float32x4'>;
    meta: WgpuBuffer<'float32x4'>;
};

function makeParticles(renderer: WebGPURenderer, count: number, lifetime: (i: number) => number): Particles {
    const pos = new WgpuBuffer({ renderer, format: 'float32x4', count });
    const vel = new WgpuBuffer({ renderer, format: 'float32x4', count });
    const meta = new WgpuBuffer({ renderer, format: 'float32x4', count });
    // Staggered ages, so they don't all spawn on the first frame. Everyone starts
    // expired-ish at the bed and respawns into place within a lifetime.
    const p = new Float32Array(count * 4);
    const m = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
        const life = lifetime(i);
        p.set([ORIGIN.x, ORIGIN.y - 10, ORIGIN.z, Math.random() * life], i * 4);
        m.set([life, Math.floor(Math.random() * 1000), 0, 0], i * 4);
    }
    pos.upload(p);
    meta.upload(m);
    vel.clear();
    return { count, pos, vel, meta };
}

/** Four hashes in [0, 1) of a particle and its generation, so each respawn differs. */
function respawnRandom(index: TslNode, generation: TslNode, salt: number): TslNode {
    const seed = uint(index)
        .mul(uint(4))
        .add(uint(generation).mul(uint(0x9e3779b1)))
        .add(uint(salt * 4));
    return vec4(hash(seed), hash(seed.add(uint(1))), hash(seed.add(uint(2))), hash(seed.add(uint(3))));
}

/** A point on the coal bed, uniform over the disc, `lift` up. */
function onBed(r: TslNode, radius: number, lift: TslNode): TslNode {
    const angle = r.x.mul(Math.PI * 2);
    const at = sqrt(r.y).mul(radius);
    return v3(FLAME_ORIGIN).add(vec3(cos(angle).mul(at), lift, sin(angle).mul(at)));
}

/** Each particle, guarded. */
function perParticle(label: string, count: number, body: (index: TslNode) => void): WgpuCompute {
    return new WgpuCompute({
        label,
        body: ({ index }) => {
            If(index.lessThan(uint(count)), () => body(index));
        },
    });
}

/* flame */

/**
 * The flame is drawn the way the closed-form one was, because that read as fire:
 * each particle carries a TEMPERATURE along its path (lit on the coals, burning
 * briefly, then cooling as it mixes with air), is drawn in toward the fire's axis so
 * the tongues taper, and is drawn as a streak along its velocity. What the
 * simulation adds is the air: the grid's flow carries the tongues so they roll,
 * lean together and part, and the smoke above rises from the same heat.
 */
const FLAME = {
    count: 62000,
    glowCount: 6000,
    /** Seconds a particle lives, from the coals to gone: short, so the fire is quick and low. */
    life: [0.35, 0.7],
    /**
     * How much of the grid's flow a flame particle takes on, sideways and up. The
     * grid sways and leans the tongues; their height is their own buoyancy's.
     */
    couplingSide: 0.6,
    couplingUp: 0.12,
    riseSpeed: 2.0,
    /** Pull toward the fire's axis, and the radius the pull and the edge-cooling work over. */
    inflow: 0.3,
    baseRadius: 0.5,
    burnRate: 15.0,
    burnTime: 0.3,
    mixing: 2.1,
    turbulence: 0.7,
    curlScale: 5.0,
    curlScroll: 3.0,
    curlEvolve: 2.6,
    size: 0.015,
    stretch: 2.4,
    opacity: 0.35,
    /** Opacity against temperature: higher thins the cooling tips to nothing and keeps the core solid. */
    glowFalloff: 1.6,
    glowSize: 0.1,
    glowOpacity: 0.01,
    glowSharpness: 4.0,
    /**
     * The gas's colour by temperature, from the core down: it runs past 1 at the
     * core, which clips to white on screen and blooms, through yellow and orange to
     * red, then soot-brown at the tips, where it also thins to nothing.
     */
    white: [1.7, 1.55, 1.25],
    yellow: [1.3, 1.0, 0.45],
    orange: [1.0, 0.52, 0.14],
    red: [0.7, 0.2, 0.05],
    soot: [0.3, 0.07, 0.02],
    /** Temperatures the tips thin out between. */
    tipThin: [0.12, 0.4],
    /** Fed, the fire runs whiter; at rest, more orange: a shift up the ramp per unit of heat above resting. */
    fedShift: 0.25,
    /** A little random warm/cool tint per particle, so the body isn't one flat colour. */
    tint: 0.08,
    /** The clean blue burn right at the wood: colour, and how far above the bed it shows. */
    blue: [0.4, 0.5, 1.3],
    blueHeight: 0.07,
} as const;

/** The flame's colour at temperature t, 0..1. */
function flameColour(t: TslNode): TslNode {
    const c = v3(FLAME.soot).toVar();
    c.assign(mix(c, v3(FLAME.red), smoothstep(0.0, 0.3, t)));
    c.assign(mix(c, v3(FLAME.orange), smoothstep(0.3, 0.5, t)));
    c.assign(mix(c, v3(FLAME.yellow), smoothstep(0.5, 0.75, t)));
    c.assign(mix(c, v3(FLAME.white), smoothstep(0.75, 1.0, t)));
    return c;
}

function makeFlame(renderer: WebGPURenderer, grid: Grid, u: FrameUniforms) {
    const count = FLAME.count + FLAME.glowCount;
    const [lifeMin, lifeMax] = FLAME.life;
    const particles = makeParticles(renderer, count, () => lifeMin + Math.random() * (lifeMax - lifeMin));
    const { pos, vel, meta } = particles;

    // State: pos.w age; vel.w temperature; meta: life, generation, unused, fuel.
    const update = perParticle('fireFlame', count, (index) => {
        const p = pos.element(index).toVar();
        const v = vel.element(index).toVar();
        const m = meta.element(index).toVar();
        const age = p.w.add(u.dt).toVar();

        If(age.greaterThan(m.x), () => {
            const generation = m.y.add(1);
            const r = respawnRandom(index, generation, 1);
            const r2 = respawnRandom(index, generation, 4);
            // Born anywhere on the bed, with the fuel the bed has there: a particle on
            // a hot patch becomes a tongue, one on a cold patch barely glows.
            const start = onBed(r, COALS.radius, r.w.mul(0.03).add(0.01)).toVar();
            const fuel = bedBurn(start.xz, u.time, u.heat).mul(r.z.mul(0.4).add(0.8)).toVar();
            const life = mix(lifeMin, lifeMax, r2.x).mul(fuel.mul(0.5).add(0.6));
            pos.element(index).assign(vec4(start, 0));
            vel.element(index).assign(vec4(0, 0, 0, fuel.mul(0.35)));
            meta.element(index).assign(vec4(life, generation, 0, fuel));
        }).Else(() => {
            const lifeFraction = age.div(m.x).toVar();
            const temp = v.w.toVar();
            const fuel = m.w;

            const fromAxis = p.xz.sub(v3(FLAME_ORIGIN).xz).toVar();
            const axisDist = length(fromAxis).toVar();

            // The air: the grid's flow, plus fine curl the grid is too coarse for.
            const flow = sampleGrid(grid.velA, toCells(p.xyz)).xyz;
            const fieldPos = p.xyz.mul(FLAME.curlScale).sub(vec3(0, u.time.mul(FLAME.curlScroll), 0));
            const coolGasWanders = temp.mul(-0.45).add(1.35);
            const curl = flameCurl(fieldPos, u.time.mul(FLAME.curlEvolve))
                .mul(lifeFraction.mul(0.9).add(0.56).mul(coolGasWanders).mul(FLAME.turbulence))
                .toVar();

            // Burn, then cool: faster at the fire's edge and where the air shears.
            const stillBurning = smoothstep(0, FLAME.burnTime, lifeFraction).oneMinus();
            temp.addAssign(fuel.mul(stillBurning).mul(u.dt).mul(FLAME.burnRate));
            const edgeExposure = min(axisDist.div(FLAME.baseRadius), 1.6);
            const shear = length(curl).div(FLAME.turbulence);
            const airMixing = edgeExposure
                .mul(1.2)
                .add(0.3)
                .add(shear.mul(0.8))
                .mul(lifeFraction.mul(1.6).add(0.3))
                .mul(FLAME.mixing);
            temp.assign(min(temp.mul(exp(airMixing.mul(u.dt).negate())), 1));

            // Drawn in toward the fire's axis, so tongues taper; lifted by its own heat.
            const draft = fromAxis
                .negate()
                .div(max(axisDist, 1e-4))
                .mul(
                    lifeFraction
                        .mul(0.7)
                        .oneMinus()
                        .mul(min(axisDist.div(FLAME.baseRadius), 1.5))
                        .mul(FLAME.inflow),
                );
            const own = vec3(draft.x, temp.mul(FLAME.riseSpeed), draft.y);
            const carried = vec3(flow.x.mul(FLAME.couplingSide), flow.y.mul(FLAME.couplingUp), flow.z.mul(FLAME.couplingSide));
            const next = own.add(carried).add(curl).toVar();

            pos.element(index).assign(vec4(p.xyz.add(next.mul(u.dt)), age));
            vel.element(index).assign(vec4(next, temp));
        });
    });

    const object = SplatCollection.object({
        count,
        generator: {
            generateSplat: (index: TslNode) => {
                const p = pos.element(index).toVar();
                const v = vel.element(index).toVar();
                const m = meta.element(index).toVar();
                const lifeFraction = clamp(p.w.div(m.x), 0, 1).toVar();
                const temp = v.w.toVar();
                const hotness = max(temp, 0).toVar();
                const r = hash(uint(index).add(uint(77777))).toVar();
                const r2 = hash(uint(index).add(uint(31337))).toVar();

                const r3 = hash(uint(index).add(uint(9191)));
                const shifted = clamp(temp.add(u.heat.sub(0.45).mul(FLAME.fedShift)), 0, 1);
                const tintAmount = r3.sub(0.5).mul(FLAME.tint);
                const tinted = flameColour(shifted).mul(vec3(tintAmount.add(1), 1, tintAmount.oneMinus()));
                // Right at the wood the gas burns clean and blue, where there's fuel to burn.
                const height = p.y.sub(FLAME_ORIGIN[1]);
                const blueAmount = smoothstep(FLAME.blueHeight, 0, height).mul(m.w).mul(0.7);
                const rgb = mix(tinted, v3(FLAME.blue), blueAmount);
                const heatBoost = u.heat.mul(0.6).add(0.55);

                // The last GLOW_COUNT are a few wide, faint splats that haze the flame's body.
                const isGlow = uint(index).greaterThanEqual(uint(FLAME.count));
                const glowFade = smoothstep(0, 0.1, lifeFraction).mul(smoothstep(0.55, 1, lifeFraction).oneMinus());
                const glowScale = r.mul(0.6).add(0.7).mul(FLAME.glowSize);
                const glowOpacity = pow(hotness, FLAME.glowSharpness).mul(heatBoost).mul(glowFade).mul(FLAME.glowOpacity);

                const fade = smoothstep(0, 0.06, lifeFraction).mul(smoothstep(0.7, 1, lifeFraction).oneMinus());
                const swell = pow(sin(lifeFraction.mul(Math.PI)), r2.mul(1.1).add(0.55));
                const scale = swell.mul(r.mul(0.7).add(0.6)).mul(u.heat.mul(0.5).add(0.7)).mul(FLAME.size).toVar();
                const tip = smoothstep(FLAME.tipThin[0], FLAME.tipThin[1], temp);
                const tongueOpacity = pow(hotness, FLAME.glowFalloff).mul(tip).mul(heatBoost).mul(fade).mul(FLAME.opacity);

                return GpuSplats.Splat(
                    p.xyz,
                    select(isGlow, vec3(glowScale), vec3(scale, scale.mul(FLAME.stretch), scale)),
                    select(isGlow, vec4(0, 0, 0, 1), flameAlignY(normalize(v.xyz.add(vec3(0, 1e-3, 0))))),
                    rgb,
                    select(isGlow, glowOpacity, tongueOpacity),
                    uint(index),
                );
            },
        },
    });

    return { particles, update, object };
}

/* smoke */

const SMOKE = {
    count: 5000,
    life: [6, 14],
    /** Where puffs are released above the coals: they only show where the grid has smoke. */
    liftOff: [0.3, 1.0],
    jitter: 0.18,
    jitterScale: 1.2,
    /** Its own slow rise on top of the air's, m/s, so it leaves rather than pooling; gone by the grid's top. */
    rise: 0.35,
    fadeFrom: 3.2,
    fadeTo: 5.0,
    startSize: 0.08,
    endSize: 0.32,
    /**
     * Each particle carries a density that follows the grid's at this rate per
     * second: the grid's smoke comes in puffs, and following it exactly drew blobs.
     */
    follow: 1.5,
    /** Opacity per unit of that density, and the cap. */
    opacity: 0.012,
    maxOpacity: 0.007,
    edge: [0.2, 0.19, 0.21],
    core: [0.07, 0.07, 0.08],
    /** The fire's light on smoke still warm from it. */
    firelit: [1.0, 0.6, 0.3],
} as const;

function makeSmoke(renderer: WebGPURenderer, grid: Grid, u: FrameUniforms) {
    const [lifeMin, lifeMax] = SMOKE.life;
    const particles = makeParticles(renderer, SMOKE.count, () => lifeMin + Math.random() * (lifeMax - lifeMin));
    const { pos, vel, meta } = particles;

    const update = perParticle('fireSmoke', SMOKE.count, (index) => {
        const p = pos.element(index).toVar();
        const m = meta.element(index).toVar();
        const age = p.w.add(u.dt).toVar();

        If(age.greaterThan(m.x), () => {
            const generation = m.y.add(1);
            const r = respawnRandom(index, generation, 2);
            const life = mix(lifeMin, lifeMax, r.z);
            const lift = mix(SMOKE.liftOff[0], SMOKE.liftOff[1], r.w);
            pos.element(index).assign(vec4(onBed(r, COALS.radius * 0.8, lift), 0));
            vel.element(index).assign(vec4(0));
            meta.element(index).assign(vec4(life, generation, 0, 0));
        }).Else(() => {
            const prev = vel.element(index).toVar();
            const cells = toCells(p.xyz);
            const air = sampleGrid(grid.airA, cells).toVar();
            const flow = sampleGrid(grid.velA, cells).xyz;
            const detail = flameCurl(p.xyz.mul(SMOKE.jitterScale), u.time.mul(0.15)).mul(SMOKE.jitter);
            const v = flow
                .add(detail)
                .add(vec3(0, SMOKE.rise, 0))
                .toVar();
            pos.element(index).assign(vec4(p.xyz.add(v.mul(u.dt)), age));
            // The smoke here (followed, not matched), and the warmth it still carries for the glow.
            vel.element(index).assign(vec4(v, mix(prev.w, air.y, min(u.dt.mul(SMOKE.follow), 1))));
            meta.element(index).assign(vec4(m.x, m.y, air.x, 0));
        });
    });

    const object = SplatCollection.object({
        count: SMOKE.count,
        generator: {
            generateSplat: (index: TslNode) => {
                const p = pos.element(index).toVar();
                const v = vel.element(index).toVar();
                const m = meta.element(index).toVar();
                const lifeFraction = clamp(p.w.div(m.x), 0, 1).toVar();
                const fade = smoothstep(0, 0.08, lifeFraction).mul(smoothstep(0.6, 1, lifeFraction).oneMinus());
                const density = v.w;
                const thick = clamp(density.mul(0.8), 0, 1).toVar();
                const warmth = clamp(m.z, 0, 1);
                const rgb = mix(v3(SMOKE.edge), v3(SMOKE.core), thick).add(v3(SMOKE.firelit).mul(warmth.mul(0.9)));
                const r = hash(uint(index).add(uint(5151)));
                const size = mix(SMOKE.startSize, SMOKE.endSize, pow(lifeFraction, 0.6)).mul(r.mul(0.6).add(0.7));
                return GpuSplats.Splat(
                    p.xyz,
                    vec3(size),
                    vec4(0, 0, 0, 1),
                    rgb,
                    min(density.mul(SMOKE.opacity), SMOKE.maxOpacity)
                        .mul(fade)
                        .mul(smoothstep(SMOKE.fadeFrom, SMOKE.fadeTo, p.y.sub(FLAME_ORIGIN[1])).oneMinus()),
                    uint(index),
                );
            },
        },
    });

    return { particles, update, object };
}

/* embers */

const EMBERS = {
    count: 1500,
    /** Most wink out in the air as they cool; the odd heavy one lands. */
    life: [0.8, 3.2],
    /**
     * Birth chance per second for each dead ember: at rest, and per unit of stoke
     * flare². With most dead, about 8 sparks a second at rest and ~120 in a stoke.
     */
    restingRate: 0.0055,
    flareRate: 0.08,
    /** Launch: upward m/s, and the outward kick a stoke adds. */
    launch: [0.6, 1.8],
    burst: 1.6,
    /** How quickly an ember takes on the air's velocity, per second, and its fall, m/s². */
    drag: 2.6,
    gravity: 2.2,
    /** The ground the clearing sits on, world y. */
    groundY: 0.08,
    size: 0.006,
    streak: 0.5,
    opacity: 0.85,
    hot: [1.0, 0.85, 0.5],
    cool: [0.95, 0.38, 0.1],
} as const;

function makeEmbers(renderer: WebGPURenderer, grid: Grid, u: FrameUniforms) {
    const [lifeMin, lifeMax] = EMBERS.life;
    // All dead to begin with: they're born at the emission rate.
    const particles = makeParticles(renderer, EMBERS.count, () => 0);
    const { pos, vel, meta } = particles;

    const update = perParticle('fireEmbers', EMBERS.count, (index) => {
        const p = pos.element(index).toVar();
        const v = vel.element(index).toVar();
        const m = meta.element(index).toVar();
        const age = p.w.add(u.dt).toVar();

        If(age.greaterThan(m.x), () => {
            // Dead: each frame, a chance to be born, higher while the fire flares.
            const roll = hash(
                uint(index)
                    .mul(uint(7919))
                    .add(uint(u.frame).mul(uint(104729))),
            );
            const rate = u.pulse.mul(u.pulse).mul(EMBERS.flareRate).add(EMBERS.restingRate);
            If(roll.lessThan(rate.mul(u.dt)), () => {
                const generation = m.y.add(1);
                const r = respawnRandom(index, generation, 3);
                const life = mix(lifeMin, lifeMax, r.z);
                const start = onBed(r, COALS.radius * 0.7, float(0.12));
                const outward = normalize(start.xz.sub(v3(FLAME_ORIGIN).xz).add(vec2(1e-4, 0)));
                const kick = u.pulse.mul(EMBERS.burst).mul(r.w.mul(0.8).add(0.4));
                const up = mix(EMBERS.launch[0], EMBERS.launch[1], r.w).mul(u.pulse.mul(0.6).add(1));
                pos.element(index).assign(vec4(start, 0));
                vel.element(index).assign(vec4(outward.x.mul(kick), up, outward.y.mul(kick), 0));
                meta.element(index).assign(vec4(life, generation, 0, 0));
            }).Else(() => {
                pos.element(index).assign(vec4(p.xyz, age));
            });
        }).Else(() => {
            const landed = m.z.greaterThan(0.5);
            If(landed, () => {
                pos.element(index).assign(vec4(p.xyz, age));
            }).Else(() => {
                const flow = sampleGrid(grid.velA, toCells(p.xyz)).xyz;
                const next = v.xyz
                    .add(flow.sub(v.xyz).mul(min(u.dt.mul(EMBERS.drag), 1)))
                    .add(vec3(0, -EMBERS.gravity, 0).mul(u.dt))
                    .toVar();
                const moved = p.xyz.add(next.mul(u.dt)).toVar();
                If(moved.y.lessThan(EMBERS.groundY).and(next.y.lessThan(0)), () => {
                    // Down: it stays where it fell, glowing out.
                    pos.element(index).assign(vec4(moved.x, EMBERS.groundY + 0.005, moved.z, age));
                    vel.element(index).assign(vec4(0));
                    meta.element(index).assign(vec4(m.x, m.y, 1, age));
                }).Else(() => {
                    pos.element(index).assign(vec4(moved, age));
                    vel.element(index).assign(vec4(next, 0));
                });
            });
        });
    });

    const object = SplatCollection.object({
        count: EMBERS.count,
        generator: {
            generateSplat: (index: TslNode) => {
                const p = pos.element(index).toVar();
                const v = vel.element(index).toVar();
                const m = meta.element(index).toVar();
                const alive = p.w.lessThan(m.x);
                const lifeFraction = clamp(p.w.div(max(m.x, 1e-3)), 0, 1).toVar();
                const r = hash(uint(index).add(uint(4242)));
                const wink = sin(p.w.mul(9).add(r.mul(40)))
                    .mul(0.45)
                    .add(0.55);
                // Landed embers cool from the moment they land.
                const sinceLanding = select(m.z.greaterThan(0.5), p.w.sub(m.w), float(0));
                const cooling = smoothstep(0, 0.8, lifeFraction.add(sinceLanding.mul(0.25)));
                const fade = smoothstep(0, 0.03, lifeFraction).mul(smoothstep(0.55, 1, lifeFraction).oneMinus());
                const scale = r.mul(0.8).add(0.6).mul(EMBERS.size).toVar();
                const streak = length(v.xyz).mul(EMBERS.streak).add(1);
                return GpuSplats.Splat(
                    p.xyz,
                    vec3(scale, scale.mul(streak), scale),
                    flameAlignY(normalize(v.xyz.add(vec3(0, 1e-3, 0)))),
                    mix(v3(EMBERS.hot), v3(EMBERS.cool), cooling),
                    select(alive, wink.mul(fade).mul(EMBERS.opacity), float(0)),
                    uint(index),
                );
            },
        },
    });

    return { particles, update, object };
}

/* the frame */

export type FireSim = {
    flame: SplatObject;
    smoke: SplatObject;
    embers: SplatObject;
    step(dt: number, time: number, fire: Fire, wind: THREE.Vector2): void;
};

/** Longest step the fluid takes: a slower frame runs the fire in slow motion rather than twice. */
const MAX_STEP = 1 / 30;

export function initFireSim(renderer: WebGPURenderer): FireSim {
    const grid = makeGrid(renderer);
    const u: FrameUniforms = {
        dt: uniform(1 / 60),
        time: uniform(0),
        heat: uniform(0),
        pulse: uniform(0),
        wind: uniform(new THREE.Vector3()),
        frame: uniform(0),
    };

    const advect = makeAdvect(grid, u);
    const curl = makeCurl(grid);
    const confine = makeConfine(grid, u);
    const divergence = makeDivergence(grid);
    const jacobiAB = makeJacobi(grid, grid.pressureA, grid.pressureB, 'firePressureAB');
    const jacobiBA = makeJacobi(grid, grid.pressureB, grid.pressureA, 'firePressureBA');
    const project = makeProject(grid);

    const flame = makeFlame(renderer, grid, u);
    const smoke = makeSmoke(renderer, grid, u);
    const embers = makeEmbers(renderer, grid, u);

    const batch = new WgpuComputeBatch(renderer);
    let frame = 0;

    return {
        flame: flame.object,
        smoke: smoke.object,
        embers: embers.object,

        step(dt, time, fire, wind) {
            const steps = 1;
            u.dt.value = Math.min(dt, MAX_STEP);
            u.time.value = time;
            u.heat.value = fireHeat(fire);
            u.pulse.value = Math.min(fire.pulse, 1.5);
            (u.wind.value as THREE.Vector3).set(wind.x, 0, wind.y).multiplyScalar(AIR.gusts);

            for (let s = 0; s < steps; s++) {
                u.frame.value = frame++;
                batch.add(advect, CELLS).add(curl, CELLS).add(confine, CELLS).add(divergence, CELLS);
                for (let i = 0; i < JACOBI_ITERATIONS / 2; i++) batch.add(jacobiAB, CELLS).add(jacobiBA, CELLS);
                batch
                    .add(project, CELLS)
                    .add(flame.update, flame.particles.count)
                    .add(smoke.update, smoke.particles.count)
                    .add(embers.update, embers.particles.count);
                batch.submit();
            }
        },
    };
}
