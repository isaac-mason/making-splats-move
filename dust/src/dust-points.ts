import { TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import { PointsNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import { DEFAULT_DUST, type DustParams } from './dust';

/**
 * The same dust, done the obvious way — a point-sprite cloud — kept as a
 * counter-example. Off by default; flip it on in the debug panel.
 *
 * The motion is a straight port of the splat kernel in src/dust.ts, so the only
 * difference you're looking at is how the motes reach the screen. And it's a big
 * one: splats test depth but don't write it (they're sorted and blended, not
 * z-buffered), so the depth buffer holds nothing of the greenhouse. A sprite has
 * nothing to be tested against — every mote draws straight over leaves, glass
 * and frames, whatever's in front of it. Fixing that means depth-sorting the
 * sprites against the splat scene yourself, which is exactly the work the splat
 * generator version gets for free by being splats.
 *
 * WebGPU has no sized point primitive, so the cloud is one instanced quad per
 * mote: what three's PointsNodeMaterial draws for a mesh, with the quad corners
 * as the geometry and the mote's seed as an instanced attribute.
 */

const { attribute, cos, distance, dot, exp, float, fract, mix, pow, sin, smoothstep, uniform, uv, vec3, cameraPosition } = TSL;

export type DustPoints = {
    object: THREE.Mesh;
    count: number;
    /** Advance the field and track the camera. Call once per frame. */
    update(dt: number, camera: THREE.Camera, renderer: WebGPURenderer): void;
};

const TAU = Math.PI * 2;

export function createDustPoints(box: THREE.Box3, params: Partial<DustParams> = {}): DustPoints {
    const p: DustParams = { ...DEFAULT_DUST, ...params };

    const size = new THREE.Vector3().subVectors(box.max, box.min);
    const volume = Math.max(size.x * size.y * size.z, 1e-6);
    const count = Math.max(1, Math.min(1_000_000, Math.round(volume * p.density)));

    // Sprites need a vertex per mote, so the seeds that the splat version hashes
    // from its index live in a buffer here instead: one quad, instanced per mote.
    const random = new Float32Array(count * 4);
    for (let i = 0; i < random.length; i++) random[i] = Math.random();
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('random', new THREE.InstancedBufferAttribute(random, 4));
    geometry.instanceCount = count;

    const u = {
        min: uniform(box.min.clone()),
        size: uniform(size.clone()),
        drift: uniform(new THREE.Vector3()),
        time: uniform(0),
        minScale: uniform(p.minScale),
        maxScale: uniform(p.maxScale),
        swirl: uniform(p.swirl),
        swirlSpeed: uniform(p.swirlSpeed),
        bob: uniform(p.bob),
        bobSpeed: uniform(p.bobSpeed),
        opacity: uniform(p.opacity),
        twinkle: uniform(p.twinkle),
        twinkleSharp: uniform(p.twinkleSharpness),
        twinkleSpeed: uniform(p.twinkleSpeed),
        nearFade: uniform(p.nearFade),
        color1: uniform(new THREE.Vector3(p.color1.r, p.color1.g, p.color1.b)),
        color2: uniform(new THREE.Vector3(p.color2.r, p.color2.g, p.color2.b)),
        pixelsPerUnit: uniform(1),
    };

    const seedNode: TslNode = attribute('random', 'vec4');
    const seed = seedNode.w;
    const phase = seed.mul(TAU);
    const base = u.min.add(fract(seedNode.xyz.add(u.drift)).mul(u.size));
    const st = u.time.mul(u.swirlSpeed);
    const swirl = vec3(
        sin(st.add(base.z.mul(0.9)).add(phase)),
        sin(st.mul(0.7).add(base.x.mul(1.1)).add(phase.mul(1.3))),
        cos(st.mul(0.85).add(base.y).add(phase.mul(0.7))),
    ).mul(u.swirl);
    const bob = sin(u.time.mul(u.bobSpeed).add(phase)).mul(u.bob);
    const center = base
        .add(swirl)
        .add(vec3(0, bob, 0))
        .toVar();

    const t = fract(seed.mul(97));
    const radius = mix(u.minScale, u.maxScale, t.mul(t).mul(t));
    const wave = sin(u.time.mul(u.twinkleSpeed).mul(TAU).add(phase.mul(3.1)))
        .mul(0.5)
        .add(0.5);
    const brightness = mix(u.twinkle.oneMinus(), float(1), pow(wave, u.twinkleSharp));
    const near = smoothstep(u.nearFade.mul(0.2), u.nearFade, distance(center, cameraPosition));

    const color = mix(u.color1, u.color2, fract(seed.mul(13)))
        .mul(brightness)
        .toVarying('vColor');
    const opacity = u.opacity.mul(brightness).mul(near).toVarying('vOpacity');
    // A splat's scale is one standard deviation; cover ~3 of them each side so
    // the sprite matches the splat's visible footprint.
    const viewZ = distance(center, cameraPosition);
    const pixels = radius.mul(6).mul(u.pixelsPerUnit).div(viewZ);

    const material = new PointsNodeMaterial();
    material.positionNode = center;
    material.sizeNode = pixels;
    material.sizeAttenuation = false;
    // Same Gaussian falloff as a splat, so the motes look alike in isolation.
    const q = uv().sub(0.5).mul(6);
    material.colorNode = color;
    material.opacityNode = exp(dot(q, q).mul(-0.5)).mul(opacity);
    material.transparent = true;
    // Depth-tested like any well-behaved transparent object — it just doesn't
    // help, because the splats never wrote any depth to test against.
    material.depthTest = true;
    material.depthWrite = false;

    const object = new THREE.Mesh(geometry, material);
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
            u.time.value = time;
            const drift: THREE.Vector3 = u.drift.value;
            drift.x += (p.drift.x / size.x) * dt;
            drift.y += (p.drift.y / size.y) * dt;
            drift.z += (p.drift.z / size.z) * dt;
            // World units at distance 1 → pixels, for perspective-correct sizing.
            // The material multiplies by the device pixel ratio itself.
            renderer.getDrawingBufferSize(drawSize);
            const proj = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
            u.pixelsPerUnit.value = (proj * drawSize.y * 0.5) / renderer.getPixelRatio();
        },
    };
}
