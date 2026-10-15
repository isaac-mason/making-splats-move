/**
 * The fire lighting the clearing, in three parts:
 *
 *   core     — a small additive glow right at the fire. Kept tight: a broad additive
 *              glow washes the scene's detail out.
 *   ambient  — a MULTIPLY over the whole clearing (after Spark's dynamic lighting
 *              example), darkening toward a warm dusk and lifting as the fire is fed.
 *   firelight — light FROM the flame onto what faces it: each splat's normal (its
 *              thinnest axis) against the direction to a light that sways with the
 *              flame and leans with the wind, so the stones' fire-side faces catch it
 *              and their backs don't. Round splats have no facing and take half.
 *   night    — beyond the firelight, the rest of the capture (trees, sky) dimmed
 *              toward dark, fading in over NIGHT_FADE past the ambient sphere.
 *   point    — a real THREE.PointLight, since the other two only touch splats.
 *              Nothing here is a mesh yet; it lights whatever you add.
 *
 * Core and ambient were Spark SplatEdit spheres. Here they're one modifier on the
 * scene's generator, with the same field math: each is a soft-edged sphere that
 * blends its colour in by how far inside a splat sits. All three flicker and swell
 * with the fire.
 */

import { GpuSplats, type SplatModifier, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';
import type { Fire } from './fire';
import { FIRE_ORIGIN } from './scene';
import { v3 } from './tsl';

const { clamp, distance, dot, float, length, max, min, mix, select, uniform, vec4 } = TSL;
const { clamp: clampNumber, lerp } = THREE.MathUtils;

const ORIGIN = new THREE.Vector3(...FIRE_ORIGIN);

const CORE_RADIUS = 0.85;
const CORE_SOFT_EDGE = 0.7;
const CORE_HUE = 0.1;
const CORE_SAT = 0.35;
const CORE_LIGHTNESS: [number, number] = [0.12, 0.3]; // resting, fed
const CORE_FLICKER = 0.12;
const CORE_PULSE = 0.2;

const AMBIENT_RADIUS = 5;
// A hard edge, so it's near-uniform inside.
const AMBIENT_SOFT_EDGE = 0.05;
const AMBIENT_HUE = 0.09;
const AMBIENT_SAT = 0.18; // multiply over-saturates if this is high
const AMBIENT_OPACITY = 0.8;
const AMBIENT_LIGHTNESS: [number, number] = [0.7, 1.0]; // resting, fed
const AMBIENT_FLICKER = 0.09;
const AMBIENT_SAT_FLICKER = 0.12;
const AMBIENT_HUE_FLICKER = 0.008;

/** How bright the world beyond the firelight stays, 0..1. A uniform, tuned live from the debug panel. */
export const NIGHT_BRIGHTNESS = 0.24;
/** The distance past the ambient sphere over which night falls. */
const NIGHT_FADE = 6;

/** Firelight strength, resting and fed, and how far it carries (metres to half strength). */
const FIRELIGHT: [number, number] = [0.55, 1.5];
const FIRELIGHT_REACH = 2.2;
const FIRELIGHT_FLICKER = 0.35;
/** Where the light sits over the coals, and how far the wind leans it per m/s. */
const LIGHT_HEIGHT = 0.45;
const LIGHT_LEAN = 0.15;

const POINT_COLOR = new THREE.Color(1, 0.78, 0.58);
const POINT_INTENSITY: [number, number] = [2, 8]; // resting, fed
const POINT_FLICKER = 0.3;
const POINT_PULSE = 5;
/** Range-limited so the far walls stay dark. It sits where the firelight does. */
const POINT_RANGE = 5;

export type Lighting = {
    /** Apply to the scene's splats only. */
    modifier: SplatModifier;
    /** 1 lit, 0 off: a uniform, so toggling compiles nothing. */
    enabled: TslNode;
    coreColor: TslNode;
    ambientColor: TslNode;
    night: TslNode;
    firelight: TslNode;
    lightPosition: TslNode;
    cameraPosition: TslNode;
    coreHelper: THREE.Mesh;
    ambientHelper: THREE.Mesh;
    pointLight: THREE.PointLight;
};

export function initLighting(): Lighting {
    const enabled = uniform(1);
    const coreColor = uniform(new THREE.Color(1, 0.7, 0.4));
    const ambientColor = uniform(new THREE.Color(1, 0.8, 0.6));
    const night = uniform(NIGHT_BRIGHTNESS);
    const firelight = uniform(new THREE.Color());
    const lightPosition = uniform(ORIGIN.clone());
    const cameraPosition = uniform(new THREE.Vector3());
    const origin = v3(FIRE_ORIGIN);

    /** How far inside a soft-edged sphere `pos` is: 0 outside, 1 well inside. */
    const inside = (pos: TslNode, radius: number, softEdge: number) =>
        clamp(distance(pos, origin).sub(radius).negate().div(softEdge).add(0.5), 0, 1).mul(enabled);

    const modifier: SplatModifier = (splat) => {
        const out = splat.toVar();
        const pos = splat.get('center').toVar();
        const rgba = vec4(splat.get('rgb'), splat.get('opacity')).toVar();

        // Spark's ADD_RGBA adds the opacity too, so the core also firms up faint splats.
        rgba.assign(mix(rgba, rgba.add(vec4(coreColor, 1)), inside(pos, CORE_RADIUS, CORE_SOFT_EDGE)));
        rgba.assign(mix(rgba, rgba.mul(vec4(ambientColor, AMBIENT_OPACITY)), inside(pos, AMBIENT_RADIUS, AMBIENT_SOFT_EDGE)));

        // Firelight: Lambert against the splat's normal, turned to face the camera
        // (a splat's normal has no sign; the side we see is the one that's lit).
        const normal = GpuSplats.normalOf(splat).toVar();
        const facingAway = dot(pos.sub(cameraPosition), normal).greaterThan(0);
        const n = select(facingAway, normal.negate(), normal);
        const toLight = lightPosition.sub(pos).toVar();
        const lightDistance = max(length(toLight), 1e-3).toVar();
        const scales = splat.get('scales').toVar();
        const thinnest = min(scales.x, min(scales.y, scales.z));
        const widest = max(scales.x, max(scales.y, scales.z));
        const middle = scales.x.add(scales.y).add(scales.z).sub(thinnest).sub(widest);
        const flat = thinnest.div(max(middle, 1e-6)).oneMinus();
        const lambert = mix(0.5, clamp(dot(n, toLight.div(lightDistance)), 0, 1), flat);
        const reach = lightDistance.div(FIRELIGHT_REACH);
        const falloff = float(1).div(reach.mul(reach).add(1));
        rgba.xyz.addAssign(rgba.xyz.mul(firelight).mul(lambert.mul(falloff).mul(enabled)));

        // Night is the far side of the same falloff: 1 inside the firelight, `night` well beyond it.
        const firelit = clamp(distance(pos, origin).sub(AMBIENT_RADIUS).div(NIGHT_FADE).oneMinus(), 0, 1);
        rgba.xyz.mulAssign(mix(night, 1, firelit.mul(enabled).add(enabled.oneMinus())));

        out.get('rgb').assign(rgba.xyz);
        // Above 1 would read as a merged LoD splat and grow it.
        out.get('opacity').assign(clamp(rgba.w, 0, 1));
        return out;
    };

    const pointLight = new THREE.PointLight(POINT_COLOR, POINT_INTENSITY[0], POINT_RANGE, 2);

    return {
        modifier,
        enabled,
        coreColor,
        ambientColor,
        night,
        firelight,
        lightPosition,
        cameraPosition,
        coreHelper: wireframe(CORE_RADIUS),
        ambientHelper: wireframe(AMBIENT_RADIUS),
        pointLight,
    };
}

export function updateLighting(
    lighting: Lighting,
    fire: Fire,
    time: number,
    { enabled, showHelpers, night }: { enabled: boolean; showHelpers: boolean; night: number },
    wind: THREE.Vector2,
    camera: THREE.Camera,
): void {
    const chaotic = flicker(time);
    const calm = (Math.sin(time * 2.0) + Math.sin(time * 3.6) * 0.25) / 1.25;
    // The clearing breathes with a blend of both: connected to the fire, but not wild.
    const clearing = calm * 0.5 + chaotic * 0.5;
    const fed = clampNumber(fire.intensity, 0, 1);

    lighting.enabled.value = enabled ? 1 : 0;
    lighting.night.value = night;
    camera.getWorldPosition(lighting.cameraPosition.value);

    // The light rides the flame: bobbing with its flicker, leaning downwind.
    const light: THREE.Vector3 = lighting.lightPosition.value;
    light.copy(ORIGIN);
    light.x += wind.x * LIGHT_LEAN + Math.sin(time * 7.3) * 0.03;
    light.y += LIGHT_HEIGHT + chaotic * 0.06;
    light.z += wind.y * LIGHT_LEAN + Math.sin(time * 5.1 + 1.0) * 0.03;
    lighting.pointLight.position.copy(light);

    const strength = (lerp(...FIRELIGHT, fed) + fire.pulse) * (1 + chaotic * FIRELIGHT_FLICKER);
    (lighting.firelight.value as THREE.Color).copy(POINT_COLOR).multiplyScalar(Math.max(strength, 0));
    lighting.pointLight.visible = enabled;
    lighting.pointLight.intensity = (lerp(...POINT_INTENSITY, fed) + fire.pulse * POINT_PULSE) * (1 + calm * POINT_FLICKER);

    const coreL = lerp(...CORE_LIGHTNESS, fed) + fire.pulse * CORE_PULSE + chaotic * CORE_FLICKER;
    const core: THREE.Color = lighting.coreColor.value;
    core.setHSL(CORE_HUE, CORE_SAT, clampNumber(coreL, 0, 1));

    const ambient: THREE.Color = lighting.ambientColor.value;
    ambient.setHSL(
        AMBIENT_HUE + clearing * AMBIENT_HUE_FLICKER,
        clampNumber(AMBIENT_SAT + clearing * AMBIENT_SAT_FLICKER, 0, 1),
        clampNumber(lerp(...AMBIENT_LIGHTNESS, fed) + clearing * AMBIENT_FLICKER, 0, 1),
    );

    lighting.coreHelper.visible = showHelpers;
    lighting.ambientHelper.visible = showHelpers;
    if (showHelpers) {
        (lighting.coreHelper.material as THREE.MeshBasicMaterial).color.copy(core);
        (lighting.ambientHelper.material as THREE.MeshBasicMaterial).color.copy(ambient);
    }
}

/** Stacked sines at unrelated speeds: a chaotic, fire-like flicker, -1..1. */
function flicker(time: number): number {
    return (Math.sin(time * 4) + Math.sin(time * 9) * 0.6 + Math.sin(time * 16) * 0.3) / 1.9;
}

/** A debug wireframe of a light sphere, drawn over the splats and ignored by raycasts. */
function wireframe(radius: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 16),
        // Transparent, so it draws in the pass after the splats; no depth test, so on top.
        new THREE.MeshBasicMaterial({ wireframe: true, depthTest: false, depthWrite: false, transparent: true }),
    );
    mesh.position.copy(ORIGIN);
    mesh.visible = false;
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    return mesh;
}
