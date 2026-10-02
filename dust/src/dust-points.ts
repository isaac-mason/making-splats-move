import * as THREE from 'three';

import { DEFAULT_DUST, type DustParams } from './dust';

/**
 * The same dust, done the obvious way — a `THREE.Points` cloud — kept as a
 * counter-example. Off by default; flip it on in the debug panel.
 *
 * The motion is a straight port of the splat kernel in src/dust.ts, so the only
 * difference you're looking at is how the motes reach the screen. And it's a big
 * one: Spark draws splats with `depthWrite: false` (they're sorted and blended,
 * not z-buffered), so the depth buffer holds nothing of the greenhouse. A point
 * has nothing to be tested against — every mote draws straight over leaves,
 * glass and frames, whatever's in front of it. Fixing that means depth-sorting
 * the points against the splat scene yourself, which is exactly the work the
 * `SplatGenerator` version gets for free by being splats.
 */

export type DustPoints = {
    object: THREE.Points;
    count: number;
    /** Advance the field and track the camera. Call once per frame. */
    update(dt: number, camera: THREE.Camera, renderer: THREE.WebGLRenderer): void;
};

const vertexShader = /* glsl */ `
uniform vec3 uMin;
uniform vec3 uSize;
uniform vec3 uDrift;
uniform float uTime;
uniform float uMinScale;
uniform float uMaxScale;
uniform float uSwirl;
uniform float uSwirlSpeed;
uniform float uBob;
uniform float uBobSpeed;
uniform float uOpacity;
uniform float uTwinkle;
uniform float uTwinkleSharp;
uniform float uTwinkleSpeed;
uniform float uNearFade;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform float uPixelsPerUnit;

attribute vec4 random;

varying vec3 vColor;
varying float vOpacity;

const float TAU = 6.28318530718;

void main() {
    float seed = random.w;
    float phase = seed * TAU;

    vec3 base = uMin + fract(random.xyz + uDrift) * uSize;

    float st = uTime * uSwirlSpeed;
    vec3 swirl = vec3(
        sin(st * 1.0 + base.z * 0.9 + phase),
        sin(st * 0.7 + base.x * 1.1 + phase * 1.3),
        cos(st * 0.85 + base.y * 1.0 + phase * 0.7)
    ) * uSwirl;
    float bob = sin(uTime * uBobSpeed + phase) * uBob;
    vec3 center = base + swirl + vec3(0.0, bob, 0.0);

    float t = fract(seed * 97.0);
    float radius = mix(uMinScale, uMaxScale, t * t * t);

    float wave = 0.5 + 0.5 * sin(uTime * uTwinkleSpeed * TAU + phase * 3.1);
    float brightness = mix(1.0 - uTwinkle, 1.0, pow(wave, uTwinkleSharp));

    float near = smoothstep(uNearFade * 0.2, uNearFade, distance(center, cameraPosition));

    vColor = mix(uColor1, uColor2, fract(seed * 13.0)) * brightness;
    vOpacity = uOpacity * brightness * near;

    vec4 mvPosition = modelViewMatrix * vec4(center, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    // A splat's scale is one standard deviation; cover ~3 of them each side so
    // the sprite matches the splat's visible footprint.
    gl_PointSize = radius * 6.0 * uPixelsPerUnit / -mvPosition.z;
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
varying float vOpacity;

void main() {
    // Same Gaussian falloff as a splat, so the motes look alike in isolation.
    vec2 p = (gl_PointCoord - 0.5) * 6.0;
    float a = exp(-0.5 * dot(p, p)) * vOpacity;
    if (a < 1.0 / 255.0) discard;
    gl_FragColor = vec4(vColor, a);
}
`;

export function createDustPoints(box: THREE.Box3, params: Partial<DustParams> = {}): DustPoints {
    const p: DustParams = { ...DEFAULT_DUST, ...params };

    const size = new THREE.Vector3().subVectors(box.max, box.min);
    const volume = Math.max(size.x * size.y * size.z, 1e-6);
    const count = Math.max(1, Math.min(1_000_000, Math.round(volume * p.density)));

    // Points need a vertex per mote, so the seeds that the splat version hashes
    // from its index live in a buffer here instead. Positions are computed in the
    // shader; the position attribute only exists because three.js wants one.
    const random = new Float32Array(count * 4);
    for (let i = 0; i < random.length; i++) random[i] = Math.random();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('random', new THREE.BufferAttribute(random, 4));

    const uniforms = {
        uMin: { value: box.min.clone() },
        uSize: { value: size.clone() },
        uDrift: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uMinScale: { value: p.minScale },
        uMaxScale: { value: p.maxScale },
        uSwirl: { value: p.swirl },
        uSwirlSpeed: { value: p.swirlSpeed },
        uBob: { value: p.bob },
        uBobSpeed: { value: p.bobSpeed },
        uOpacity: { value: p.opacity },
        uTwinkle: { value: p.twinkle },
        uTwinkleSharp: { value: p.twinkleSharpness },
        uTwinkleSpeed: { value: p.twinkleSpeed },
        uNearFade: { value: p.nearFade },
        uColor1: { value: p.color1.clone() },
        uColor2: { value: p.color2.clone() },
        uPixelsPerUnit: { value: 1 },
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
        transparent: true,
        // Depth-tested like any well-behaved transparent object — it just doesn't
        // help, because the splats never wrote any depth to test against.
        depthTest: true,
        depthWrite: false,
    });

    const object = new THREE.Points(geometry, material);
    // Draw after the splats, as transparent geometry in a splat scene ends up.
    object.renderOrder = 1;
    // The real positions are shader-side, so the all-zero bound would cull them.
    object.frustumCulled = false;
    object.visible = false;

    const drawSize = new THREE.Vector2();
    let time = 0;

    return {
        object,
        count,
        update(dt, camera, renderer) {
            time += dt;
            uniforms.uTime.value = time;
            uniforms.uDrift.value.x += (p.drift.x / size.x) * dt;
            uniforms.uDrift.value.y += (p.drift.y / size.y) * dt;
            uniforms.uDrift.value.z += (p.drift.z / size.z) * dt;
            // World units at distance 1 → pixels, for perspective-correct sizing.
            renderer.getDrawingBufferSize(drawSize);
            const proj = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
            uniforms.uPixelsPerUnit.value = proj * drawSize.y * 0.5;
        },
    };
}
