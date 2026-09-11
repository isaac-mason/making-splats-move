// Ember sparks: a pooled THREE.Points system — a steady trickle off the fire plus a
// burst whenever it's stoked.
// CPU-simulated (gravity + drag + lifetime), additive-blended for a glowing look.
import * as THREE from 'three';
import type { Vec3 } from './scene';

const MAX_SPARKS = 300;
const LIFETIME = 1.2; // seconds a spark lives (longer → travels further)
const SPEED = 1.3; // initial launch speed (world units / s)
const SPARK_GRAVITY = -0.3; // negative = gentle ember rise (they don't fall)
const DRAG = 0.97; // per-frame velocity damping (higher → coasts further)
const SIZE = 16; // base point size factor (× pixelRatio / depth)

// Embers shoot mostly to the right (+X) and a little up, spreading in a cone.
const DIR: Vec3 = [1, 0.45, 0.05];
const SPREAD = 1.0; // cone half-width (bigger = wider spread)
const DLEN = Math.hypot(DIR[0], DIR[1], DIR[2]);

const vertexShader = /* glsl */ `
    uniform float uSize;
    uniform float uPixelRatio;
    attribute float aLife;
    varying float vLife;
    void main() {
        vLife = aLife;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uSize * uPixelRatio * aLife / -mv.z, 0.0, 64.0);
    }
`;

const fragmentShader = /* glsl */ `
    uniform vec3 uHot;
    uniform vec3 uCool;
    varying float vLife;
    void main() {
        if (vLife <= 0.0) discard;
        float d = length(gl_PointCoord - 0.5);
        float soft = 1.0 - smoothstep(0.1, 0.5, d);
        // hot/white when fresh, cooling to red as it dies; additive blend
        vec3 col = mix(uCool, uHot, vLife);
        gl_FragColor = vec4(col * soft * vLife, 1.0);
    }
`;

export type Sparks = {
    points: THREE.Points;
    positions: Float32Array;
    lifes: Float32Array; // aLife attribute, 0..1
    vel: Float32Array; // CPU only
    ttl: Float32Array; // seconds remaining (0 = dead)
    posAttr: THREE.BufferAttribute;
    lifeAttr: THREE.BufferAttribute;
};

export function initSparks(): Sparks {
    const positions = new Float32Array(MAX_SPARKS * 3);
    const lifes = new Float32Array(MAX_SPARKS); // all 0 → dead
    const vel = new Float32Array(MAX_SPARKS * 3);
    const ttl = new Float32Array(MAX_SPARKS);

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    const lifeAttr = new THREE.BufferAttribute(lifes, 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('aLife', lifeAttr);

    const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uSize: { value: SIZE },
            uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
            uHot: { value: new THREE.Color(1.0, 0.85, 0.5) },
            uCool: { value: new THREE.Color(0.9, 0.25, 0.05) },
        },
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 11; // after the dust

    return { points, positions, lifes, vel, ttl, posAttr, lifeAttr };
}

// Fire a burst of `count` embers from `origin`, flying outward + up.
export function sparksBurst(sparks: Sparks, origin: Vec3, count: number): void {
    let spawned = 0;
    for (let i = 0; i < MAX_SPARKS && spawned < count; i++) {
        if (sparks.ttl[i] > 0) continue; // still alive

        sparks.positions[i * 3] = origin[0];
        sparks.positions[i * 3 + 1] = origin[1];
        sparks.positions[i * 3 + 2] = origin[2];

        // base direction (right + a little up) jittered within a cone, then scaled
        let vx = DIR[0] / DLEN + (Math.random() * 2 - 1) * SPREAD;
        let vy = DIR[1] / DLEN + (Math.random() * 2 - 1) * SPREAD;
        let vz = DIR[2] / DLEN + (Math.random() * 2 - 1) * SPREAD;
        const len = Math.hypot(vx, vy, vz) || 1;
        const speed = SPEED * (0.5 + Math.random() * 0.5);
        vx = (vx / len) * speed;
        vy = (vy / len) * speed;
        vz = (vz / len) * speed;
        sparks.vel[i * 3] = vx;
        sparks.vel[i * 3 + 1] = vy;
        sparks.vel[i * 3 + 2] = vz;

        sparks.ttl[i] = LIFETIME * (0.6 + Math.random() * 0.4);
        sparks.lifes[i] = sparks.ttl[i] / LIFETIME;
        spawned++;
    }
    sparks.posAttr.needsUpdate = true;
    sparks.lifeAttr.needsUpdate = true;
}

export function updateSparks(sparks: Sparks, dt: number): void {
    const drag = DRAG ** (dt * 60); // frame-rate-corrected damping
    let any = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
        if (sparks.ttl[i] <= 0) continue;
        any = true;

        sparks.vel[i * 3] *= drag;
        sparks.vel[i * 3 + 1] = sparks.vel[i * 3 + 1] * drag - SPARK_GRAVITY * dt;
        sparks.vel[i * 3 + 2] *= drag;

        sparks.positions[i * 3] += sparks.vel[i * 3] * dt;
        sparks.positions[i * 3 + 1] += sparks.vel[i * 3 + 1] * dt;
        sparks.positions[i * 3 + 2] += sparks.vel[i * 3 + 2] * dt;

        sparks.ttl[i] -= dt;
        sparks.lifes[i] = Math.max(sparks.ttl[i], 0) / LIFETIME;
    }
    if (any) {
        sparks.posAttr.needsUpdate = true;
        sparks.lifeAttr.needsUpdate = true;
    }
}
