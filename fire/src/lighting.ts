/**
 * The fire lighting the clearing, in three parts:
 *
 *   core     — a small additive SplatEdit glow right at the fire. Kept tight: a
 *              broad additive glow washes the scene's detail out.
 *   ambient  — a MULTIPLY SplatEdit over the whole clearing (after Spark's dynamic
 *              lighting example), darkening toward a warm dusk and lifting as the
 *              fire is fed.
 *   point    — a real THREE.PointLight, since SplatEdits only touch splats. Nothing
 *              here is a mesh yet; it lights whatever you add.
 *
 * All three flicker and swell with the fire.
 */

import { SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType } from '@sparkjsdev/spark';
import * as THREE from 'three';
import type { Fire } from './fire';
import { FIRE_ORIGIN } from './scene';

const { clamp, lerp } = THREE.MathUtils;

const ORIGIN = new THREE.Vector3(...FIRE_ORIGIN);

const CORE_RADIUS = 0.85;
const CORE_HUE = 0.075;
const CORE_SAT = 0.55;
const CORE_LIGHTNESS: [number, number] = [0.12, 0.3]; // resting, fed
const CORE_FLICKER = 0.12;
const CORE_PULSE = 0.2;

const AMBIENT_RADIUS = 5;
const AMBIENT_HUE = 0.05;
const AMBIENT_SAT = 0.35; // multiply over-saturates if this is high
const AMBIENT_OPACITY = 0.8;
const AMBIENT_LIGHTNESS: [number, number] = [0.66, 1.0]; // resting, fed
const AMBIENT_FLICKER = 0.09;
const AMBIENT_SAT_FLICKER = 0.12;
const AMBIENT_HUE_FLICKER = 0.008;

const POINT_COLOR = new THREE.Color(1, 0.55, 0.25);
const POINT_INTENSITY: [number, number] = [2, 8]; // resting, fed
const POINT_FLICKER = 0.3;
const POINT_PULSE = 5;
/** Lifted above the coals so light falls down and out, and range-limited so the far walls stay dark. */
const POINT_HEIGHT = 0.4;
const POINT_RANGE = 5;

export type Lighting = {
    coreLayer: SplatEdit;
    core: SplatEditSdf;
    coreHelper: THREE.Mesh;
    ambientLayer: SplatEdit;
    ambient: SplatEditSdf;
    ambientHelper: THREE.Mesh;
    pointLight: THREE.PointLight;
};

export function initLighting(): Lighting {
    const coreLayer = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.ADD_RGBA, sdfSmooth: 0.1, softEdge: 0.7 });
    const core = sphere(CORE_RADIUS, new THREE.Color(1, 0.7, 0.4), 1);
    coreLayer.add(core);

    // A hard edge, so it's near-uniform inside.
    const ambientLayer = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, sdfSmooth: 0.1, softEdge: 0.05 });
    const ambient = sphere(AMBIENT_RADIUS, new THREE.Color(1, 0.8, 0.6), AMBIENT_OPACITY);
    ambientLayer.add(ambient);

    const pointLight = new THREE.PointLight(POINT_COLOR, POINT_INTENSITY[0], POINT_RANGE, 2);
    pointLight.position.copy(ORIGIN);
    pointLight.position.y += POINT_HEIGHT;

    return {
        coreLayer,
        core,
        coreHelper: wireframe(CORE_RADIUS, core.color),
        ambientLayer,
        ambient,
        ambientHelper: wireframe(AMBIENT_RADIUS, ambient.color),
        pointLight,
    };
}

export function updateLighting(lighting: Lighting, fire: Fire, time: number, showHelpers: boolean): void {
    const chaotic = flicker(time);
    const calm = (Math.sin(time * 2.0) + Math.sin(time * 3.6) * 0.25) / 1.25;
    // The clearing breathes with a blend of both: connected to the fire, but not wild.
    const clearing = calm * 0.5 + chaotic * 0.5;
    const fed = clamp(fire.intensity, 0, 1);

    lighting.pointLight.intensity = (lerp(...POINT_INTENSITY, fed) + fire.pulse * POINT_PULSE) * (1 + calm * POINT_FLICKER);

    const coreL = lerp(...CORE_LIGHTNESS, fed) + fire.pulse * CORE_PULSE + chaotic * CORE_FLICKER;
    lighting.core.color.setHSL(CORE_HUE, CORE_SAT, clamp(coreL, 0, 1));

    lighting.ambient.color.setHSL(
        AMBIENT_HUE + clearing * AMBIENT_HUE_FLICKER,
        clamp(AMBIENT_SAT + clearing * AMBIENT_SAT_FLICKER, 0, 1),
        clamp(lerp(...AMBIENT_LIGHTNESS, fed) + clearing * AMBIENT_FLICKER, 0, 1),
    );

    lighting.coreHelper.visible = showHelpers;
    lighting.ambientHelper.visible = showHelpers;
    if (showHelpers) {
        (lighting.coreHelper.material as THREE.MeshBasicMaterial).color.copy(lighting.core.color);
        (lighting.ambientHelper.material as THREE.MeshBasicMaterial).color.copy(lighting.ambient.color);
    }
}

/** Stacked sines at unrelated speeds: a chaotic, fire-like flicker, -1..1. */
function flicker(time: number): number {
    return (Math.sin(time * 4) + Math.sin(time * 9) * 0.6 + Math.sin(time * 16) * 0.3) / 1.9;
}

function sphere(radius: number, color: THREE.Color, opacity: number): SplatEditSdf {
    const sdf = new SplatEditSdf({ type: SplatEditSdfType.SPHERE, color, radius, opacity });
    sdf.position.copy(ORIGIN);
    return sdf;
}

/** A debug wireframe of an SDF sphere, drawn over the splats and ignored by raycasts. */
function wireframe(radius: number, color: THREE.Color): THREE.Mesh {
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 16),
        // Transparent, so it draws in the pass after the splats; no depth test, so on top.
        new THREE.MeshBasicMaterial({ wireframe: true, color, depthTest: false, depthWrite: false, transparent: true }),
    );
    mesh.position.copy(ORIGIN);
    mesh.visible = false;
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    return mesh;
}
