import { GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';

const { cos, distance, float, fract, hash, mix, pow, sin, smoothstep, uint, uniform, vec3, vec4 } = TSL;

export type DustParams = {
    density: number;
    minScale: number;
    maxScale: number;
    swirl: number;
    swirlSpeed: number;
    bob: number;
    bobSpeed: number;
    drift: THREE.Vector3;
    opacity: number;
    twinkle: number;
    twinkleSharpness: number;
    twinkleSpeed: number;
    nearFade: number;
    color1: THREE.Color;
    color2: THREE.Color;
};

export const DEFAULT_DUST: DustParams = {
    density: 6,
    minScale: 0.004,
    maxScale: 0.016,
    swirl: 0.32,
    swirlSpeed: 0.09,
    bob: 0.22,
    bobSpeed: 0.16,
    drift: new THREE.Vector3(0.012, -0.006, 0.004),
    opacity: 0.55,
    twinkle: 0.65,
    twinkleSharpness: 2.0,
    twinkleSpeed: 0.07,
    nearFade: 1.4,
    color1: new THREE.Color(1.0, 0.96, 0.86),
    color2: new THREE.Color(0.72, 0.8, 0.95),
};

const TAU = Math.PI * 2;

function hashVec4(index: TslNode): TslNode {
    const base = uint(index).mul(uint(4));
    return vec4(hash(base), hash(base.add(uint(1))), hash(base.add(uint(2))), hash(base.add(uint(3))));
}

export type Dust = {
    object: SplatObject;
    count: number;
    update(time: number, dt: number, camera: THREE.Camera): void;
    setParams(params: Partial<Omit<DustParams, 'density'>>): void;
};

export function createDust(box: THREE.Box3, params: Partial<DustParams> = {}): Dust {
    const p: DustParams = { ...DEFAULT_DUST, ...params };

    const size = new THREE.Vector3().subVectors(box.max, box.min);
    const volume = Math.max(size.x * size.y * size.z, 1e-6);
    const count = Math.max(1, Math.min(1_000_000, Math.round(volume * p.density)));

    const uMin = uniform(box.min.clone());
    const uSize = uniform(size.clone());
    const uMinScale = uniform(p.minScale);
    const uMaxScale = uniform(p.maxScale);
    const uSwirl = uniform(p.swirl);
    const uSwirlSpeed = uniform(p.swirlSpeed);
    const uBob = uniform(p.bob);
    const uBobSpeed = uniform(p.bobSpeed);
    const uOpacity = uniform(p.opacity);
    const uTwinkle = uniform(p.twinkle);
    const uTwinkleSharp = uniform(p.twinkleSharpness);
    const uTwinkleSpeed = uniform(p.twinkleSpeed);
    const uColor1 = uniform(new THREE.Vector3(p.color1.r, p.color1.g, p.color1.b));
    const uColor2 = uniform(new THREE.Vector3(p.color2.r, p.color2.g, p.color2.b));
    const uNearFade = uniform(p.nearFade);
    const uCamera = uniform(new THREE.Vector3());
    const uTime = uniform(0);
    const uDrift = uniform(new THREE.Vector3());

    const object = SplatCollection.object({
        count,
        generator: {
            generateSplat: (index: TslNode) => {
                const random = hashVec4(index).toVar();
                const seed = random.w;
                const phase = seed.mul(TAU).toVar();

                const cell = fract(random.xyz.add(uDrift));
                const base = uMin.add(cell.mul(uSize)).toVar();

                const st = uTime.mul(uSwirlSpeed).toVar();
                const swirl = vec3(
                    sin(st.add(base.z.mul(0.9)).add(phase)),
                    sin(st.mul(0.7).add(base.x.mul(1.1)).add(phase.mul(1.3))),
                    cos(st.mul(0.85).add(base.y).add(phase.mul(0.7))),
                ).mul(uSwirl);

                const bob = sin(uTime.mul(uBobSpeed).add(phase)).mul(uBob);
                const center = base
                    .add(swirl)
                    .add(vec3(0, bob, 0))
                    .toVar();

                const t = fract(seed.mul(97));
                const radius = mix(uMinScale, uMaxScale, t.mul(t).mul(t));

                const wave = sin(uTime.mul(uTwinkleSpeed).mul(TAU).add(phase.mul(3.1)))
                    .mul(0.5)
                    .add(0.5);
                const glint = pow(wave, uTwinkleSharp);
                const brightness = mix(uTwinkle.oneMinus(), float(1), glint).toVar();

                const near = smoothstep(uNearFade.mul(0.2), uNearFade, distance(center, uCamera));

                const rgb = mix(uColor1, uColor2, fract(seed.mul(13)));

                return GpuSplats.Splat(
                    center,
                    vec3(radius),
                    vec4(0, 0, 0, 1),
                    rgb.mul(brightness),
                    uOpacity.mul(brightness).mul(near),
                    uint(index),
                );
            },
        },
    });

    return {
        object,
        count,
        update(time, dt, camera) {
            uTime.value = time;
            camera.getWorldPosition(uCamera.value);
            const drift: THREE.Vector3 = uDrift.value;
            drift.x += (p.drift.x / size.x) * dt;
            drift.y += (p.drift.y / size.y) * dt;
            drift.z += (p.drift.z / size.z) * dt;
        },
        setParams(next) {
            Object.assign(p, next);
            uMinScale.value = p.minScale;
            uMaxScale.value = p.maxScale;
            uSwirl.value = p.swirl;
            uSwirlSpeed.value = p.swirlSpeed;
            uBob.value = p.bob;
            uBobSpeed.value = p.bobSpeed;
            uOpacity.value = p.opacity;
            uTwinkle.value = p.twinkle;
            uTwinkleSharp.value = p.twinkleSharpness;
            uTwinkleSpeed.value = p.twinkleSpeed;
            uNearFade.value = p.nearFade;
            uColor1.value.set(p.color1.r, p.color1.g, p.color1.b);
            uColor2.value.set(p.color2.r, p.color2.g, p.color2.b);
        },
    };
}
