/**
 * Hand-made splats on radix: a builder the shapes push splats into, and
 * dual-quaternion skinning over them (after Spark's SplatSkinning, same maths).
 *
 * Skinning is a generator: the stored splats, then each one moved by the blend of
 * its bones' transforms. Per splat, four bone indices and four weights are a bundle
 * next to the splats; the bones' transforms (relative to rest, as dual quaternions)
 * are a small table uploaded each frame. One program serves every skinned object.
 */

import {
    type AnySplatObject,
    ArrayData,
    defineBundle,
    GpuArrayReader,
    GpuArrays,
    GpuSplatMath,
    SplatCollection,
    type SplatData,
    SplatGenerator,
    type SplatNode,
    Splats,
    TSL,
    type TslNode,
} from 'spark-radix';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

const { If, dot, float, length, select, uint, vec3, vec4 } = TSL;

/* colours */

/**
 * Radix draws straight to the canvas with no output transform, so three's colours
 * are written as given: a display (sRGB) value, kept as it is rather than decoded.
 */
export const displayColor = (hex: number): THREE.Color =>
    new THREE.Color().setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, THREE.LinearSRGBColorSpace);

/* builder */

const FLOATS = 14;

/** Splats one at a time, in Spark's pushSplat order, then a table of them. */
export class SplatBuilder {
    private values = new Float32Array(4096 * FLOATS);
    count = 0;

    /** `opacity` may run past 1 for a harder edge: the object's params turn lodInflate off for it. */
    pushSplat(
        center: THREE.Vector3,
        scales: THREE.Vector3,
        quaternion: THREE.Quaternion,
        opacity: number,
        color: THREE.Color,
    ): void {
        if ((this.count + 1) * FLOATS > this.values.length) {
            const grown = new Float32Array(this.values.length * 2);
            grown.set(this.values);
            this.values = grown;
        }
        const o = this.count * FLOATS;
        const v = this.values;
        v[o] = center.x;
        v[o + 1] = center.y;
        v[o + 2] = center.z;
        v[o + 3] = scales.x;
        v[o + 4] = scales.y;
        v[o + 5] = scales.z;
        v[o + 6] = quaternion.x;
        v[o + 7] = quaternion.y;
        v[o + 8] = quaternion.z;
        v[o + 9] = quaternion.w;
        v[o + 10] = color.r;
        v[o + 11] = color.g;
        v[o + 12] = color.b;
        v[o + 13] = opacity;
        this.count++;
    }

    centerOf(i: number, out: THREE.Vector3): THREE.Vector3 {
        const o = i * FLOATS;
        return out.set(this.values[o], this.values[o + 1], this.values[o + 2]);
    }

    build(): SplatData {
        const data = Splats.make(this.count);
        const encode = Splats.encoder(Splats.get(data).bundle);
        const s = Splats.makeExtSplat();
        const v = this.values;
        for (let i = 0; i < this.count; i++) {
            const o = i * FLOATS;
            [s.center.x, s.center.y, s.center.z] = [v[o], v[o + 1], v[o + 2]];
            [s.scales.x, s.scales.y, s.scales.z] = [v[o + 3], v[o + 4], v[o + 5]];
            [s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w] = [v[o + 6], v[o + 7], v[o + 8], v[o + 9]];
            s.rgb.r = v[o + 10];
            s.rgb.g = v[o + 11];
            s.rgb.b = v[o + 12];
            s.opacity = v[o + 13];
            encode(i, s);
        }
        return data;
    }
}

/* skinning */

/** Per splat: four bone indices (x, a byte each) and four weights (y, a byte each). */
const SKIN = defineBundle({ skin: 'uint32x2' });
/** Per bone: the transform from rest to now, as a dual quaternion. */
const BONES = defineBundle({ real: 'float32x4', dual: 'float32x4' });

const relQuat = new THREE.Quaternion();
const relPos = new THREE.Vector3();
const dual = new THREE.Quaternion();

export class Skinning {
    readonly numSplats: number;
    readonly numBones: number;
    private readonly rest: { quat: THREE.Quaternion; pos: THREE.Vector3 }[];
    private readonly skin: Uint32Array<ArrayBuffer>;
    private readonly bones: ArrayData;
    private readonly real: Float32Array;
    private readonly dual: Float32Array;
    private bonesGpu: GpuArrays | null = null;

    constructor(numSplats: number, numBones: number) {
        this.numSplats = numSplats;
        this.numBones = numBones;
        this.rest = Array.from({ length: numBones }, () => ({ quat: new THREE.Quaternion(), pos: new THREE.Vector3() }));
        this.skin = new Uint32Array(numSplats * 2);
        this.bones = new ArrayData({ bundles: { bones: BONES }, count: numBones });
        this.real = this.bones.bundles.bones.channels.real.data as Float32Array;
        this.dual = this.bones.bundles.bones.channels.dual.data as Float32Array;
        for (let i = 0; i < numBones; i++) this.real[i * 4 + 3] = 1;
    }

    setRestQuatPos(bone: number, quat: THREE.Quaternion, pos: THREE.Vector3): void {
        this.rest[bone].quat.copy(quat);
        this.rest[bone].pos.copy(pos);
        this.setBoneQuatPos(bone, quat, pos);
    }

    /** The bone's transform now, in the space the rest pose was given in. */
    setBoneQuatPos(bone: number, quat: THREE.Quaternion, pos: THREE.Vector3): void {
        const rest = this.rest[bone];
        relQuat.copy(rest.quat).invert();
        relPos.copy(pos).sub(rest.pos);
        relQuat.multiply(quat);
        dual.set(relPos.x, relPos.y, relPos.z, 0).multiply(relQuat);
        this.real.set([relQuat.x, relQuat.y, relQuat.z, relQuat.w], bone * 4);
        this.dual.set([dual.x * 0.5, dual.y * 0.5, dual.z * 0.5, dual.w * 0.5], bone * 4);
    }

    /** Up to four bones per splat; unused ones take weight 0. */
    setSplatBones(splat: number, indices: THREE.Vector4, weights: THREE.Vector4): void {
        const byte = (w: number) => Math.min(255, Math.max(0, Math.round(w * 255)));
        this.skin[splat * 2] = (indices.x | (indices.y << 8) | (indices.z << 16) | (indices.w << 24)) >>> 0;
        this.skin[splat * 2 + 1] =
            (byte(weights.x) | (byte(weights.y) << 8) | (byte(weights.z) << 16) | (byte(weights.w) << 24)) >>> 0;
    }

    /** Adds the per-splat bones to the splats' table. Once, before uploading it. */
    addTo(data: SplatData): void {
        data.addBundle('skin', SKIN, { data: { skin: this.skin } });
    }

    /** The bones as they are now, onto the GPU: every frame after moving them. */
    upload(renderer: WebGPURenderer): GpuArrays {
        if (this.bonesGpu) this.bonesGpu.upload(this.bones);
        else this.bonesGpu = GpuArrays.fromData(renderer, this.bones);
        return this.bonesGpu;
    }

    dispose(): void {
        this.bonesGpu?.dispose();
        this.bonesGpu = null;
    }
}

/* generator */

type SkinnedData = { splats: GpuArrays; bones: GpuArrays };

const stored = SplatGenerator.fromSplats({ layout: 'extSplats' });
const skinReader = new GpuArrayReader(SKIN);
const boneReader = new GpuArrayReader(BONES);

function applySkinning(s: SplatNode, index: TslNode): void {
    const packed = skinReader.load('skin', index).toVar();
    const q = vec4(0).toVar();
    const d = vec4(0).toVar();
    for (let k = 0; k < 4; k++) {
        const shift = uint(8 * k);
        const weight = float(packed.y.shiftRight(shift).bitAnd(uint(255))).div(255);
        const bone = packed.x.shiftRight(shift).bitAnd(uint(255));
        const boneReal = boneReader.load('real', bone).toVar();
        const boneDual = boneReader.load('dual', bone).toVar();
        if (k > 0) {
            // The same rotation as the blend so far, not its opposite.
            const sign = select(dot(q, boneReal).lessThan(0), float(-1), float(1));
            boneReal.mulAssign(sign);
            boneDual.mulAssign(sign);
        }
        q.addAssign(boneReal.mul(weight));
        d.addAssign(boneDual.mul(weight));
    }

    const norm = length(q);
    If(norm.greaterThan(1e-6), () => {
        q.divAssign(norm);
        d.divAssign(norm);
        const translate = vec3(
            d.w.negate().mul(q.x).add(d.x.mul(q.w)).sub(d.y.mul(q.z)).add(d.z.mul(q.y)),
            d.w.negate().mul(q.y).add(d.x.mul(q.z)).add(d.y.mul(q.w)).sub(d.z.mul(q.x)),
            d.w.negate().mul(q.z).sub(d.x.mul(q.y)).add(d.y.mul(q.x)).add(d.z.mul(q.w)),
        ).mul(2);
        s.get('center').assign(GpuSplatMath.quatRotate(q, s.get('center')).add(translate));
        s.get('quaternion').assign(GpuSplatMath.quatMul(q, s.get('quaternion')));
    });
}

const skinned: SplatGenerator<SkinnedData> = {
    generateSplat(index) {
        const s = stored.generateSplat?.(index).toVar() as SplatNode;
        applySkinning(s, index);
        return s;
    },
    bind(data) {
        stored.bind?.(data);
        skinReader.bind(data.splats, 'skin');
        boneReader.bind(data.bones, 'bones');
    },
};

/** Past-opaque splats keep their hard edge rather than growing (the LoD reading of opacity > 1). */
const PARAMS = { lodInflate: false };

/** The builder's splats as one object, skinned when `skinning` is given, placed by `holder`. */
export function splatObject(
    renderer: WebGPURenderer,
    data: SplatData,
    holder: THREE.Object3D,
    skinning?: Skinning,
): { object: AnySplatObject; arrays: GpuArrays } {
    if (skinning) skinning.addTo(data);
    const arrays = GpuArrays.fromData(renderer, data);
    const matrixWorld = holder.matrixWorld;
    const object: AnySplatObject = skinning
        ? SplatCollection.object({
              generator: skinned,
              data: { splats: arrays, bones: skinning.upload(renderer) },
              count: arrays.count,
              matrixWorld,
              params: PARAMS,
          })
        : SplatCollection.arrays(arrays, { matrixWorld, params: PARAMS });
    return { object, arrays };
}
