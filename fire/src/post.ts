import { TSL } from '@sparkjsdev/radix';
import * as THREE from 'three';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';

const { pass, screenUV, smoothstep, vec4 } = TSL;

export const BLOOM_STRENGTH = 0.14;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 0.6;
const VIGNETTE = 0.3;

export type Post = {
    pipeline: RenderPipeline;
    strength: { value: number };
};

export function initPost(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): Post {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const pipeline = new RenderPipeline(renderer);

    const color = pass(scene, camera).getTextureNode('output');
    const glow = bloom(color, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);

    const fromCentre = screenUV.sub(0.5).length().mul(1.35);
    const vignette = smoothstep(0.35, 1.0, fromCentre).mul(VIGNETTE).oneMinus();
    pipeline.outputNode = vec4(color.add(glow).rgb.mul(vignette), 1);

    return { pipeline, strength: glow.strength };
}
