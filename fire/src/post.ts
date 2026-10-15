/**
 * The finish: bloom and a vignette, as a TSL post pass over the whole frame.
 *
 * Bloom is thresholded, so only what's genuinely bright glows: the flame, the
 * coals, sparks, fireflies and the string lights in the capture. That glow is what
 * makes them read as light sources rather than orange paint. The vignette pulls
 * the eye in to the fire.
 *
 * Splats blend in sRGB-encoded colour, as they were trained, but into the pass's
 * half-float target radix writes them decoded to linear. So the pipeline's output
 * transform encodes back to sRGB (no tone mapping), and the frame comes out as it
 * would drawn straight to the canvas, plus the glow. The bloom threshold is
 * therefore in linear terms: 0.6 is about 0.8 encoded.
 */

import { TSL } from 'spark-radix';
import * as THREE from 'three';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';

const { pass, screenUV, smoothstep, vec4 } = TSL;

/** Glow strength, and the brightness (sRGB-encoded, 0..1) where glowing starts. */
export const BLOOM_STRENGTH = 0.14;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 0.6;
/** How much the corners darken. */
const VIGNETTE = 0.3;

export type Post = {
    pipeline: RenderPipeline;
    /** Set `.value` to change the glow live. */
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
