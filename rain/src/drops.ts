import { GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import type { Reach } from './reach';

const { float, floor, fract, hash, length, max, mix, normalize, smoothstep, sqrt, texture, uint, uniform, vec2, vec3, vec4 } =
    TSL;

/* settings */

const DROPS = { count: 64_000, box: 28, fall: 14, speed: [7.5, 9.5], width: 0.0028, length: 0.12, opacity: 0.32 };

// Fade drops passing the lens: one that close fills the frame like a flash.
const NEAR_FADE = [0.4, 1.5];

const SPLASH = { life: 0.2, size: [0.012, 0.06], opacity: 0.5 };

const HEIGHTS = { step: 0.1, floor: -1.5 };

/* the rain, from the outside */

export type Rain = {
    objects: SplatObject[];
    update(time: number, camera: THREE.Vector3, wind: THREE.Vector2, rainfall: number, sky: [number, number, number]): void;
};

export function initRain(reach: Reach): Rain {
    const u = {
        time: uniform(0),
        camera: uniform(new THREE.Vector3()),
        wind: uniform(new THREE.Vector2()),
        rainfall: uniform(0),
        sky: uniform(new THREE.Vector3(0.5, 0.5, 0.5)),
    };
    const heights = heightTexture(reach);
    const extent = vec2(reach.size[0] * reach.cell, reach.size[1] * reach.cell);

    const surfaceAt = (xz: TslNode) => {
        const uv = xz
            .sub(vec2(...reach.origin))
            .div(extent)
            .toVar();
        const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
        const h = texture(heights, uv)
            .level(0)
            .r.mul(255 * HEIGHTS.step)
            .add(HEIGHTS.floor);
        return inside.select(h, float(0));
    };

    const fallOf = (index: TslNode) => {
        const speed = mix(DROPS.speed[0], DROPS.speed[1], hash(index.mul(uint(13)))).toVar();
        const rate = speed.div(DROPS.fall).toVar();
        const through = u.time
            .mul(rate)
            .add(hash(index.mul(uint(13)).add(uint(1))))
            .toVar();
        return { speed, seconds: float(1).div(rate), turn: floor(through), progress: fract(through) };
    };

    const landing = (index: TslNode, turn: TslNode) => {
        const h = (k: number) =>
            hash(
                index
                    .mul(uint(7919))
                    .add(uint(turn).mul(uint(104729)))
                    .add(uint(k)),
            );
        const spot = vec2(h(0), h(1));
        const xz = u.camera.xz
            .add(
                fract(spot.sub(u.camera.xz.div(DROPS.box)))
                    .sub(0.5)
                    .mul(DROPS.box),
            )
            .toVar();
        return { xz, falls: h(2).lessThan(u.rainfall) };
    };

    const inBox = (xz: TslNode) => smoothstep(DROPS.box * 0.5, DROPS.box * 0.5 - 4, length(xz.sub(u.camera.xz)));

    const drop = (index: TslNode) => {
        const fall = fallOf(index);
        const land = landing(index, fall.turn);
        const ground = surfaceAt(land.xz);
        const velocity = vec3(u.wind.x, fall.speed.negate(), u.wind.y).toVar();
        const left = fall.progress.oneMinus().mul(fall.seconds);
        const centre = vec3(land.xz.x, ground, land.xz.y).sub(velocity.mul(left)).toVar();
        // Rotates +y onto the direction of travel.
        const along = normalize(velocity).negate().toVar();
        const turnTo = normalize(vec4(along.z, 0, along.x.negate(), along.y.add(1)));
        const opacity = land.falls
            .select(float(DROPS.opacity), float(0))
            .mul(smoothstep(0, 0.06, fall.progress))
            .mul(smoothstep(NEAR_FADE[0], NEAR_FADE[1], length(centre.sub(u.camera))))
            .mul(inBox(land.xz));
        const rgb = u.sky.mul(1.4).add(0.08);
        return GpuSplats.Splat(centre, vec3(DROPS.width, DROPS.length, DROPS.width), turnTo, rgb, opacity, uint(index));
    };

    const splash = (index: TslNode) => {
        const fall = fallOf(index);
        const land = landing(index, fall.turn.sub(1));
        const age = fall.progress.mul(fall.seconds).div(SPLASH.life).toVar();
        const size = mix(SPLASH.size[0], SPLASH.size[1], sqrt(age.clamp(0, 1)));
        const centre = vec3(land.xz.x, surfaceAt(land.xz).add(size.mul(0.4)), land.xz.y);
        const fading = max(age.oneMinus(), 0);
        const opacity = land.falls.select(float(SPLASH.opacity), float(0)).mul(fading.mul(fading)).mul(inBox(land.xz));
        const rgb = u.sky.mul(1.3).add(0.1);
        return GpuSplats.Splat(centre, vec3(size, size.mul(0.3), size), vec4(0, 0, 0, 1), rgb, opacity, uint(index));
    };

    return {
        objects: [
            SplatCollection.object({ count: DROPS.count, generator: { generateSplat: drop } }),
            SplatCollection.object({ count: DROPS.count, generator: { generateSplat: splash } }),
        ],
        update(time, camera, wind, rainfall, sky) {
            u.time.value = time;
            u.camera.value.copy(camera);
            u.wind.value.copy(wind);
            u.rainfall.value = rainfall;
            u.sky.value.set(...sky);
        },
    };
}

function heightTexture(reach: Reach): THREE.DataTexture {
    const [nx, nz] = reach.size;
    const bytes = new Uint8Array(nx * nz);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.max(0, Math.min(255, Math.round((reach.heights[i] - HEIGHTS.floor) / HEIGHTS.step)));
    }
    const texture = new THREE.DataTexture(bytes, nx, nz, THREE.RedFormat, THREE.UnsignedByteType);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
}
