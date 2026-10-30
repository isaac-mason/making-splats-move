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
import { MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import courtyardUrl from '../../avatars/assets/school-courtyard.spz?url';
import meshUrl from '../assets/courtyard.glb?url';
import { bake, type CaptureSplats } from './bake';
import type { Daylight } from './daylight';

const {
    If,
    clamp,
    dot,
    exp,
    float,
    max,
    min,
    mix,
    positionWorld,
    sRGBTransferEOTF,
    sRGBTransferOETF,
    texture,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

const CAPTURE = { open: 0.5, floor: 0.3, albedo: 0.85 };

const SHADE = { bounce: 0.18, skyAbove: [0.8, 1.15], knee: 0.8 };

export function tone(x: TslNode): TslNode {
    const knee = float(SHADE.knee);
    return min(x, knee).add(
        exp(max(x.sub(knee), 0).negate().div(knee.oneMinus()))
            .oneMinus()
            .mul(knee.oneMinus()),
    );
}

const SHADOW = {
    size: 2048,
    half: 55,
    centre: [2, 6, -4],
    distance: 150,
    offset: 55,
    normal: 0.45,
    bias: 0.15,
    soft: 0.1,
    spread: 1.5,
};

export type Relight = {
    object: AnySplatObject;
    count: number;
    update(day: Daylight): void;
};

const LIGHT = defineBundle({ light: 'float32x4' });

export async function loadRelit(renderer: WebGPURenderer): Promise<Relight> {
    // Decoded on a worker; baked here, a couple of seconds.
    const data = await loadSplats(courtyardUrl);
    const baked = bake(readCapture(data));
    data.addBundle('light', LIGHT, { data: { light: baked.light } });
    const arrays = GpuArrays.fromData(renderer, data);

    const light = uniform(new THREE.Vector3(0, 1, 0));
    const lightColour = uniform(new THREE.Vector3());
    const skyUp = uniform(new THREE.Vector3(1, 1, 1));
    const skySide = uniform(new THREE.Vector3(1, 1, 1));
    const glow = uniform(new THREE.Vector3());
    const toward = uniform(new THREE.Vector3(0, 0, 1));
    const exposure = uniform(1);

    const shadows = await shadowMap(renderer, light);

    const reader = new GpuArrayReader(LIGHT);
    const stored = SplatGenerator.fromSplats();

    const relight = (s: SplatNode, index: TslNode) => {
        const baked = reader.load('light', index).toVar();
        If(baked.w.lessThan(0), () => {
            s.get('opacity').assign(0);
        });
        const normal = baked.xyz.toVar();
        const sky = max(baked.w, 0);
        const captured = sRGBTransferEOTF(max(s.get('rgb'), vec3(0))).toVar();

        const seen = mix(CAPTURE.floor, 1, min(sky.div(CAPTURE.open), 1));
        const albedo = min(captured.div(seen), vec3(CAPTURE.albedo));

        // A flat splat takes the light by its facing; a round one, a leaf blob, wraps it.
        const scales = s.get('scales').toVar();
        const thinnest = min(scales.x, min(scales.y, scales.z));
        const widest = max(scales.x, max(scales.y, scales.z));
        const middle = scales.x.add(scales.y).add(scales.z).sub(thinnest).sub(widest);
        const flat = clamp(thinnest.div(max(middle, 1e-6)).oneMinus().sub(0.35).div(0.45), 0, 1);
        const facing = dot(normal, light).toVar();
        const lambert = mix(
            clamp(facing.add(0.5).div(1.5), 0, 1),
            max(facing, 0),
            flat.mul(flat).mul(flat.mul(-2).add(3)),
        ).toVar();

        const shadow = float(0).toVar();
        If(lambert.greaterThan(0).and(dot(lightColour, vec3(1)).greaterThan(0)), () => {
            shadow.assign(shadows.lit(s.get('center').add(normal.mul(SHADOW.normal))));
        });

        const above = mix(SHADE.skyAbove[0], SHADE.skyAbove[1], normal.y.mul(0.5).add(0.5));
        const skyLight = mix(skySide, skyUp, max(normal.y, 0))
            .mul(above)
            .add(glow.mul(max(dot(normal, toward), 0)))
            .add(lightColour.mul(max(light.y, 0).mul(SHADE.bounce)));
        const lit = captured.mul(skyLight).add(albedo.mul(lightColour).mul(lambert.mul(shadow)));
        s.get('rgb').assign(sRGBTransferOETF(tone(lit.mul(exposure))));
    };

    const generator: SplatGenerator<{ splats: GpuArrays }> = {
        generateSplat(index) {
            const s = stored.generateSplat?.(index).toVar() as SplatNode;
            relight(s, index);
            return s;
        },
        bind(data) {
            stored.bind?.(data);
            reader.bind(data.splats, 'light');
        },
    };

    return {
        object: SplatCollection.object({ generator, data: { splats: arrays }, count: arrays.count }),
        count: arrays.count,
        update(day) {
            light.value.set(...day.light);
            shadows.render();
            lightColour.value.set(...day.lightColour);
            skyUp.value.set(...day.skyUp);
            skySide.value.set(...day.skySide);
            glow.value.set(...day.glow);
            toward.value.set(...day.toward);
            exposure.value = day.exposure;
        },
    };
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

/* the shadow map */

async function shadowMap(renderer: WebGPURenderer, light: TslNode) {
    const gltf = await new GLTFLoader().loadAsync(meshUrl);
    let geometry: THREE.BufferGeometry | null = null;
    gltf.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) geometry = (o as THREE.Mesh).geometry;
    });
    if (!geometry) throw new Error('relight: no mesh in courtyard.glb');

    const material = new MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    material.colorNode = vec4(dot(positionWorld.sub(vec3(...SHADOW.centre)), light).add(SHADOW.offset), 0, 0, 1);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));

    const target = new THREE.RenderTarget(SHADOW.size, SHADOW.size, { type: THREE.HalfFloatType, depthBuffer: true });
    target.texture.minFilter = target.texture.magFilter = THREE.NearestFilter;
    const { half, distance } = SHADOW;
    const camera = new THREE.OrthographicCamera(-half, half, half, -half, 1, distance * 2);
    const centre = new THREE.Vector3(...SHADOW.centre);
    const right = uniform(new THREE.Vector3(1, 0, 0));
    const up = uniform(new THREE.Vector3(0, 1, 0));
    // A render target's rows run down under WebGPU, up under WebGL.
    const flip = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? -1 : 1;
    const clear = new THREE.Color();

    return {
        render() {
            const toward = light.value as THREE.Vector3;
            camera.up.set(0, 1, 0);
            if (Math.abs(toward.y) > 0.99) camera.up.set(0, 0, 1);
            camera.position.copy(centre).addScaledVector(toward, distance);
            camera.lookAt(centre);
            camera.updateMatrixWorld();
            (right.value as THREE.Vector3).setFromMatrixColumn(camera.matrixWorld, 0);
            (up.value as THREE.Vector3).setFromMatrixColumn(camera.matrixWorld, 1);

            renderer.getClearColor(clear);
            const alpha = renderer.getClearAlpha();
            renderer.setClearColor(0x000000, 1);
            renderer.setRenderTarget(target);
            renderer.render(scene, camera);
            renderer.setRenderTarget(null);
            renderer.setClearColor(clear, alpha);
        },
        lit(p: TslNode): TslNode {
            const at = p.sub(vec3(...SHADOW.centre)).toVar();
            const uv = vec2(dot(at, right), dot(at, up).mul(flip))
                .div(half * 2)
                .add(0.5)
                .toVar();
            const depth = dot(at, light)
                .add(SHADOW.offset + SHADOW.bias)
                .toVar();
            const texel = SHADOW.spread / SHADOW.size;
            let sum: TslNode = float(0);
            for (let y = -1; y <= 1; y++) {
                for (let x = -1; x <= 1; x++) {
                    const nearest = texture(target.texture, uv.add(vec2(x * texel, y * texel))).level(0).r;
                    sum = sum.add(clamp(depth.sub(nearest).div(SHADOW.soft).add(1), 0, 1));
                }
            }
            return sum.div(9);
        },
    };
}
