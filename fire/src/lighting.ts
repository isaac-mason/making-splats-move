import { SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType } from '@sparkjsdev/spark';
import * as THREE from 'three';

import type { Fire } from './fire';
import { FIRE_ORIGIN } from './scene';

// Where the fire's heat/light originates, in world space.
export const LIGHT_ORIGIN = new THREE.Vector3(FIRE_ORIGIN[0], FIRE_ORIGIN[1], FIRE_ORIGIN[2]);

// A tight, intense "hot core" right at the fire — a localized additive splat glow.
// Kept small: a broad additive glow washes out the scene's detail.
const CORE_RADIUS = 0.85;
const CORE_HUE = 0.075; // hotter, toward yellow-white
const CORE_SAT = 0.55; // less saturated → whiter-hot, not deep orange
const CORE_LIGHTNESS_REST = 0.12;
const CORE_LIGHTNESS_FED = 0.3; // lower peak → hot-orange, not blown-out white
const CORE_FLICKER_AMP = 0.12; // lightness wobble of the hot core
const CORE_PULSE = 0.2; // extra core brightness on a stoke pulse

// Stacked sine waves at different speeds → a chaotic, fire-like flicker. Drives the
// hot core; exported so other systems can flicker in sync if needed.
export function flicker(time: number): number {
    const slow = Math.sin(time * 4);
    const medium = Math.sin(time * 9) * 0.6;
    const fast = Math.sin(time * 16) * 0.3;
    return (slow + medium + fast) / 1.9;
}

// A calmer flicker for the real point light — gentle breath, low variance.
function flickerCalm(time: number): number {
    return (Math.sin(time * 2.0) + Math.sin(time * 3.6) * 0.25) / 1.25;
}

// Real point light for standard-material meshes; the SDF edits only affect splats.
// Nothing in this scene is a mesh yet, so it lights whatever you add. Co-located with
// the fire, swells with it + pops on a stoke.
const POINT_LIGHT_COLOR = new THREE.Color(1, 0.55, 0.25); // warm fire
const POINT_LIGHT_REST = 2; // dim resting intensity
const POINT_LIGHT_FED = 8; // intensity with the fire fed
const POINT_LIGHT_FLICKER = 0.3; // fraction of base the (calm) flicker swings on lit meshes
const POINT_LIGHT_PULSE = 5; // extra point-light intensity on a stoke pulse → flares lit meshes
// Lift it above the coal bed so light falls down-and-out rather than streaking flat,
// and range-limit it so the fire doesn't light the far walls. The SDF glow stays at
// LIGHT_ORIGIN; only this moves.
const POINT_LIGHT_HEIGHT = 0.4; // metres above LIGHT_ORIGIN
const POINT_LIGHT_DISTANCE = 5; // range at which the light fades to nothing (falloff)
const POINT_LIGHT_DECAY = 2; // physically-correct inverse-square falloff (three default)

// Scene-wide ambient, after Spark's dynamic-lighting example: a MULTIPLY edit that
// scales every splat toward a dark warm, darkening without washing out detail.
const AMBIENT_RADIUS = 5; // covers the whole clearing (sharp edge → near-uniform inside)
const AMBIENT_HUE = 0.05;
const AMBIENT_SAT = 0.35; // gentle warm tint (multiply over-saturates if high)
const AMBIENT_OPACITY = 0.8; // how strongly it applies (0 = none, 1 = full)
const AMBIENT_MUL_REST = 0.66; // clearing multiplied toward this brightness when resting (moody, but not too dark)
const AMBIENT_MUL_FED = 1.0; // fully lifts as the fire is fed → the clearing brightening reads clearly
const AMBIENT_FLICKER_AMP = 0.09; // brightness breath on the clearing (connected to the fire's flicker)
const AMBIENT_SAT_AMP = 0.12; // warmth breath — the clearing tints warmer on flicker peaks
const AMBIENT_HUE_AMP = 0.008; // small hue wobble in sync

export type Lighting = {
    /** ADD_RGBA layer for the tight hot core. Add to your scene. */
    coreLayer: SplatEdit;
    /** Tight, intense SDF right at the fire — sells the heat. */
    core: SplatEditSdf;
    /** Wireframe sphere visualising the core SDF. Add to your scene; toggled via debug. */
    coreHelper: THREE.Mesh;
    /** MULTIPLY layer giving the clearing its moody ambient. Add to your scene. */
    ambientLayer: SplatEdit;
    /** Scene-wide SDF that darkens splats toward a dark warm. */
    ambient: SplatEditSdf;
    /** Wireframe sphere visualising the ambient SDF. Add to your scene; toggled via debug. */
    ambientHelper: THREE.Mesh;
    /** Real point light at the fire, for lighting non-splat meshes. Add to your scene. */
    pointLight: THREE.PointLight;
};

export function initLighting(): Lighting {
    // Tight hot core on its own additive layer (tight soft edge → a defined hot spot).
    const coreLayer = new SplatEdit({
        rgbaBlendMode: SplatEditRgbaBlendMode.ADD_RGBA,
        sdfSmooth: 0.1,
        softEdge: 0.7,
    });
    const core = new SplatEditSdf({
        type: SplatEditSdfType.SPHERE,
        color: new THREE.Color(1, 0.7, 0.4),
        radius: CORE_RADIUS,
        opacity: 1,
    });
    core.position.copy(LIGHT_ORIGIN);
    coreLayer.add(core);

    const coreHelper = new THREE.Mesh(
        new THREE.SphereGeometry(CORE_RADIUS, 16, 16),
        // transparent + depthTest:false + high renderOrder → draws in the transparent
        // pass after the splats, so the wireframe sits on top of everything.
        new THREE.MeshBasicMaterial({
            wireframe: true,
            color: core.color,
            depthTest: false,
            depthWrite: false,
            transparent: true,
        }),
    );
    coreHelper.position.copy(LIGHT_ORIGIN);
    coreHelper.visible = false;
    coreHelper.renderOrder = 1000;
    coreHelper.frustumCulled = false;
    coreHelper.raycast = () => {};

    // Scene-wide multiplicative ambient (sharp edge → near-uniform inside the sphere).
    const ambientLayer = new SplatEdit({
        rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
        sdfSmooth: 0.1,
        softEdge: 0.05,
    });
    const ambient = new SplatEditSdf({
        type: SplatEditSdfType.SPHERE,
        color: new THREE.Color(1, 0.8, 0.6),
        radius: AMBIENT_RADIUS,
        opacity: AMBIENT_OPACITY,
    });
    ambient.position.copy(LIGHT_ORIGIN);
    ambientLayer.add(ambient);

    const ambientHelper = new THREE.Mesh(
        new THREE.SphereGeometry(AMBIENT_RADIUS, 16, 16),
        // transparent for the same reason as coreHelper — draws on top of the splats.
        new THREE.MeshBasicMaterial({
            wireframe: true,
            color: ambient.color,
            depthTest: false,
            depthWrite: false,
            transparent: true,
        }),
    );
    ambientHelper.position.copy(LIGHT_ORIGIN);
    ambientHelper.visible = false;
    ambientHelper.renderOrder = 1000;
    ambientHelper.frustumCulled = false;
    ambientHelper.raycast = () => {};

    const pointLight = new THREE.PointLight(POINT_LIGHT_COLOR, POINT_LIGHT_REST, POINT_LIGHT_DISTANCE, POINT_LIGHT_DECAY);
    pointLight.position.copy(LIGHT_ORIGIN);
    pointLight.position.y += POINT_LIGHT_HEIGHT;

    return { coreLayer, core, coreHelper, ambientLayer, ambient, ambientHelper, pointLight };
}

// Flicker the hot core + point light with the fire. The "fed" baseline
// tracks the shared fire intensity; the blast pulse pops both. showHelper toggles
// the debug wireframe.
export function updateLighting(lighting: Lighting, fire: Fire, time: number, showHelper: boolean): void {
    const fLocal = flicker(time); // chaotic — drives the tight hot core
    const fCalm = flickerCalm(time); // gentle breath — drives the real point light

    const fed = THREE.MathUtils.clamp(fire.intensity, 0, 1); // 0 = resting, 1 = fully fed

    const baseIntensity = THREE.MathUtils.lerp(POINT_LIGHT_REST, POINT_LIGHT_FED, fed);
    lighting.pointLight.intensity = (baseIntensity + fire.pulse * POINT_LIGHT_PULSE) * (1 + fCalm * POINT_LIGHT_FLICKER);

    // Hot core: chaotic, punchy flicker + a hard pop on each stoke pulse.
    const coreLightness = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(CORE_LIGHTNESS_REST, CORE_LIGHTNESS_FED, fed) + fire.pulse * CORE_PULSE + fLocal * CORE_FLICKER_AMP,
        0,
        1,
    );
    lighting.core.color.setHSL(CORE_HUE, CORE_SAT, coreLightness);

    // Clearing ambient: multiply toward a dark warm, lifting as the fire is fed, and
    // flickering in sync with the fire — blend the chaotic core flicker into the calm
    // clearing breath so it tracks the fire's rhythm (connected) without going wild.
    const fClearing = fCalm * 0.5 + fLocal * 0.5;
    const ambientL = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(AMBIENT_MUL_REST, AMBIENT_MUL_FED, fed) + fClearing * AMBIENT_FLICKER_AMP,
        0,
        1,
    );
    const ambientSat = THREE.MathUtils.clamp(AMBIENT_SAT + fClearing * AMBIENT_SAT_AMP, 0, 1);
    const ambientHue = AMBIENT_HUE + fClearing * AMBIENT_HUE_AMP;
    lighting.ambient.color.setHSL(ambientHue, ambientSat, ambientL);

    lighting.coreHelper.visible = showHelper;
    lighting.ambientHelper.visible = showHelper;
    if (showHelper) {
        (lighting.coreHelper.material as THREE.MeshBasicMaterial).color.copy(lighting.core.color);
        (lighting.ambientHelper.material as THREE.MeshBasicMaterial).color.copy(lighting.ambient.color);
    }
}
