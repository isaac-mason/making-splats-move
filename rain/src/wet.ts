import {
    type AnySplatObject,
    defineBundle,
    GpuArrayReader,
    GpuArrays,
    loadSplats,
    SplatCollection,
    type SplatData,
    SplatGenerator,
    type SplatNode,
    Splats,
    TSL,
    type TslNode,
} from 'spark-radix';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { WebGPURenderer } from 'three/webgpu';
import courtyardUrl from '../../avatars/assets/school-courtyard.spz?url';
import { bake, type CaptureSplats } from '../../time/src/bake.ts';
import meshUrl from '../assets/courtyard.glb?url';
import { type Mesh, type Reach, reach } from './reach';

const {
    If,
    abs,
    clamp,
    dot,
    exp,
    floor,
    fract,
    length,
    max,
    min,
    mix,
    mx_noise_float,
    normalize,
    pow,
    sRGBTransferEOTF,
    sRGBTransferOETF,
    sin,
    smoothstep,
    uniform,
    vec2,
    vec3,
} = TSL;

/* settings */

const SOAK = { darken: 0.3, deepen: 0.4, walls: 0.35 };

const PUDDLE = { broad: 2.2, fine: 0.6, cover: 0.5, under: 0.25 };

const RINGS = { cell: 0.3, rate: 1.8, spread: 0.14, width: 0.014 };

const HAZE = 0.012;

/* the storm, from the outside */

export type Weather = {
    rainfall: number;
    wet: number;
    puddles: number;
    gloom: [number, number, number];
    sky: [number, number, number];
};

export type Courtyard = {
    object: AnySplatObject;
    count: number;
    reach: Reach;
    update(weather: Weather, camera: THREE.Vector3, time: number): void;
};

const LIGHT = defineBundle({ light: 'float32x4' });
const RAIN = defineBundle({ rain: 'float32x4' });

export async function loadCourtyard(renderer: WebGPURenderer): Promise<Courtyard> {
    const [data, mesh] = await Promise.all([loadSplats(courtyardUrl), loadMesh()]);
    const capture = readCapture(data);
    const baked = bake(capture);
    const reached = reach(capture, baked, mesh);
    data.addBundle('light', LIGHT, { data: { light: baked.light } });
    data.addBundle('rain', RAIN, { data: { rain: reached.rain } });
    const arrays = GpuArrays.fromData(renderer, data);

    const u = {
        rainfall: uniform(0),
        wet: uniform(0),
        puddles: uniform(0),
        gloom: uniform(new THREE.Vector3(1, 1, 1)),
        sky: uniform(new THREE.Vector3(0.5, 0.5, 0.5)),
        camera: uniform(new THREE.Vector3()),
        time: uniform(0),
    };

    const lightReader = new GpuArrayReader(LIGHT);
    const rainReader = new GpuArrayReader(RAIN);
    const stored = SplatGenerator.fromSplats();

    const soak = (s: SplatNode, index: TslNode) => {
        const light = lightReader.load('light', index).toVar();
        If(light.w.lessThan(0), () => {
            s.get('opacity').assign(0);
        });
        const normal = light.xyz.toVar();
        const rain = rainReader.load('rain', index).toVar();
        const centre = s.get('center').toVar();
        const colour = sRGBTransferEOTF(max(s.get('rgb'), vec3(0)))
            .mul(u.gloom)
            .toVar();

        const upward = smoothstep(-0.3, 0.7, normal.y);
        const wet = u.wet
            .mul(rain.x)
            .mul(mix(SOAK.walls, 1, upward))
            .toVar();
        const soaked = pow(colour, vec3(wet.mul(SOAK.deepen).add(1)))
            .mul(wet.mul(-SOAK.darken).add(1))
            .toVar();

        // Round splats are leaves: no sheen.
        const toEye = normalize(u.camera.sub(centre));
        const fresnel = pow(abs(dot(normal, toEye)).oneMinus(), 5)
            .mul(0.98)
            .add(0.02)
            .toVar();
        const scales = s.get('scales').toVar();
        const thinnest = min(scales.x, min(scales.y, scales.z));
        const middle = scales.x
            .add(scales.y)
            .add(scales.z)
            .sub(thinnest)
            .sub(max(scales.x, max(scales.y, scales.z)));
        const flat = clamp(thinnest.div(max(middle, 1e-6)).oneMinus().sub(0.35).div(0.45), 0, 1);
        const sheen = u.sky.mul(
            fresnel
                .mul(wet)
                .mul(smoothstep(0.5, 0.95, normal.y))
                .mul(flat),
        );
        const surface = soaked.add(sheen).toVar();

        If(rain.y.greaterThan(0), () => {
            const at = centre.xz.toVar();
            const field = mx_noise_float(vec3(at.div(PUDDLE.broad), 0))
                .mul(0.7)
                .add(mx_noise_float(vec3(at.div(PUDDLE.fine), 3.7)).mul(0.3))
                .mul(0.5)
                .add(0.5);
            const level = u.puddles.mul(PUDDLE.cover).oneMinus();
            const water = smoothstep(level, level.add(0.06), field).mul(rain.y);
            const ripple = rings(at, u.time).mul(u.rainfall);
            const mirror = u.sky.mul(mix(0.35, 0.9, fresnel)).mul(ripple.mul(1.2).add(1));
            surface.assign(mix(surface, soaked.mul(PUDDLE.under).add(mirror), water));
        });

        const haze = exp(length(u.camera.sub(centre)).mul(u.rainfall).mul(-HAZE)).oneMinus();
        const seen = mix(surface, u.sky.mul(0.75), haze);
        s.get('rgb').assign(sRGBTransferOETF(min(seen, vec3(1))));
    };

    const generator: SplatGenerator<{ splats: GpuArrays }> = {
        generateSplat(index) {
            const s = stored.generateSplat?.(index).toVar() as SplatNode;
            soak(s, index);
            return s;
        },
        bind(data) {
            stored.bind?.(data);
            lightReader.bind(data.splats, 'light');
            rainReader.bind(data.splats, 'rain');
        },
    };

    return {
        object: SplatCollection.object({ generator, data: { splats: arrays }, count: arrays.count }),
        count: arrays.count,
        reach: reached,
        update(weather, camera, time) {
            u.rainfall.value = weather.rainfall;
            u.wet.value = weather.wet;
            u.puddles.value = weather.puddles;
            u.gloom.value.set(...weather.gloom);
            u.sky.value.set(...weather.sky);
            u.camera.value.copy(camera);
            u.time.value = time;
        },
    };
}

function rings(at: TslNode, time: TslNode): TslNode {
    const g = at.div(RINGS.cell).toVar();
    const cell = floor(g).toVar();
    const offset = hash2(cell);
    const beat = time.mul(RINGS.rate).add(offset.x.mul(7)).toVar();
    const age = fract(beat);
    const landed = hash2(cell.add(floor(beat).mul(vec2(17.3, 5.9))))
        .mul(0.6)
        .add(0.2);
    const d = length(fract(g).sub(landed)).mul(RINGS.cell);
    const off = d.sub(age.mul(RINGS.spread)).div(RINGS.width);
    return exp(off.mul(off).negate()).mul(age.oneMinus().mul(age.oneMinus()));
}

function hash2(p: TslNode): TslNode {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))).mul(43758.5453));
}

async function loadMesh(): Promise<Mesh> {
    const gltf = await new GLTFLoader().loadAsync(meshUrl);
    let geometry: THREE.BufferGeometry | undefined;
    gltf.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) geometry = (o as THREE.Mesh).geometry;
    });
    if (!geometry?.index) throw new Error('rain: no indexed mesh in courtyard.glb');
    return { positions: geometry.attributes.position.array, indices: geometry.index.array };
}

function readCapture(data: SplatData): CaptureSplats {
    const count = data.count;
    const decode = Splats.decoder(Splats.get(data).bundle);
    const s = Splats.makeExtSplat();
    const out: CaptureSplats = {
        count,
        centers: new Float32Array(count * 3),
        scales: new Float32Array(count * 3),
        quaternions: new Float32Array(count * 4),
        opacities: new Float32Array(count),
        colours: new Float32Array(count * 3),
    };
    for (let i = 0; i < count; i++) {
        decode(i, s);
        out.centers.set([s.center.x, s.center.y, s.center.z], i * 3);
        out.scales.set([s.scales.x, s.scales.y, s.scales.z], i * 3);
        out.quaternions.set([s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w], i * 4);
        out.opacities[i] = Math.min(s.opacity, 1);
        out.colours.set([s.rgb.r, s.rgb.g, s.rgb.b], i * 3);
    }
    return out;
}
