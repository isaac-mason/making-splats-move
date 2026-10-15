/**
 * The debug panel (backtick): camera readouts, layer toggles, a heat override and
 * the render scale. While it's open, a click raycasts the scene instead of stoking
 * the fire — that's how the landmarks in scene.ts were measured.
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Fire } from './fire';
import type { Performance } from './performance';

export type DebugOverlay = {
    element: HTMLDivElement;
    text: HTMLDivElement;
    enabled: boolean;
    /** Draw the lighting's SDF spheres as wireframes. */
    showLights: boolean;
    fireEnabled: boolean;
    embersEnabled: boolean;
    firefliesEnabled: boolean;
    smokeEnabled: boolean;
    lightingEnabled: boolean;
    /** Free-look, for measuring. The shipped camera is the fixed shot plus the lean. */
    orbit: boolean;
    /** How bright the world beyond the firelight stays, 0..1. */
    night: number;
    /** Bloom strength. */
    bloom: number;
    /** Pins the fire's heat, 0..1; null = live. */
    heatOverride: number | null;
    raycaster: THREE.Raycaster;
    /** Marks the last raycast hit. Add to the scene. */
    raycastMarker: THREE.Mesh;
    lastHit: THREE.Vector3 | null;
};

type Toggle = 'fireEnabled' | 'embersEnabled' | 'smokeEnabled' | 'firefliesEnabled' | 'lightingEnabled';

const LAYERS: [string, Toggle][] = [
    ['fire', 'fireEnabled'],
    ['embers', 'embersEnabled'],
    ['smoke', 'smokeEnabled'],
    ['fireflies', 'firefliesEnabled'],
    ['lighting', 'lightingEnabled'],
];

export type DebugOptions = {
    /** `false` is the cue to put the presentation camera back where the last drag left it. */
    onOrbitChange?: (orbit: boolean) => void;
};

export function createDebugOverlay(
    perf: Performance,
    { night, bloom }: { night: number; bloom: number },
    { onOrbitChange }: DebugOptions = {},
): DebugOverlay {
    const element = document.createElement('div');
    element.style.cssText = [
        'position:fixed',
        'top:8px',
        'left:8px',
        'padding:6px 8px',
        'display:none',
        'flex-direction:column',
        'gap:4px',
        'font:12px/1.4 monospace',
        'color:#0f0',
        'background:rgba(0,0,0,0.6)',
        'z-index:1000',
    ].join(';');

    const raycastMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 16, 12),
        // Transparent, so it draws after the splats; no depth test, so on top.
        new THREE.MeshBasicMaterial({ color: 0xff3366, depthTest: false, depthWrite: false, transparent: true }),
    );
    raycastMarker.visible = false;
    raycastMarker.renderOrder = 1000;
    raycastMarker.frustumCulled = false;
    raycastMarker.raycast = () => {};

    const overlay: DebugOverlay = {
        element,
        text: document.createElement('div'),
        enabled: false,
        showLights: false,
        fireEnabled: true,
        embersEnabled: true,
        smokeEnabled: true,
        firefliesEnabled: true,
        lightingEnabled: true,
        orbit: false,
        night,
        bloom,
        heatOverride: null,
        raycaster: new THREE.Raycaster(),
        raycastMarker,
        lastHit: null,
    };

    overlay.text.style.cssText = 'white-space:pre;user-select:text;-webkit-user-select:text;cursor:text';

    element.append(
        checkbox('orbit camera', false, (on) => {
            overlay.orbit = on;
            onOrbitChange?.(on);
        }),
        checkbox('lights debug', false, (on) => (overlay.showLights = on)),
        ...LAYERS.map(([label, key]) => checkbox(label, true, (on) => (overlay[key] = on))),
        heatSlider((value) => (overlay.heatOverride = value)),
        range('night', { min: 0, max: 1, step: 0.05, value: night }, (value) => (overlay.night = value)),
        range('bloom', { min: 0, max: 2, step: 0.05, value: bloom }, (value) => (overlay.bloom = value)),
        range('render scale', { min: 0.25, max: 1, step: 0.05, value: perf.renderScale }, (value) => (perf.renderScale = value)),
        overlay.text,
    );
    document.body.appendChild(element);

    window.addEventListener('keydown', (event) => {
        if (event.key !== '`') return;
        overlay.enabled = !overlay.enabled;
        element.style.display = overlay.enabled ? 'flex' : 'none';
        if (!overlay.enabled) overlay.raycastMarker.visible = false;
    });

    return overlay;
}

/**
 * While the panel is open, a click moves the marker to whatever it hits. `pick`
 * returns the distance along the ray to the nearest hit, or null.
 */
export function attachDebugRaycast(
    overlay: DebugOverlay,
    camera: THREE.Camera,
    pick: (ray: THREE.Ray) => number | null,
    domElement: HTMLElement,
): void {
    const ndc = new THREE.Vector2();

    domElement.addEventListener('click', (event) => {
        if (!overlay.enabled) return;

        const rect = domElement.getBoundingClientRect();
        ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        overlay.raycaster.setFromCamera(ndc, camera);
        const { ray } = overlay.raycaster;
        const t = pick(ray);
        if (t === null) return;

        overlay.lastHit = ray.at(t, new THREE.Vector3());
        overlay.raycastMarker.position.copy(overlay.lastHit);
        overlay.raycastMarker.visible = true;
    });
}

export function updateDebugOverlay(
    overlay: DebugOverlay,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    fire: Fire,
    splatCount: number,
    perf: Performance,
): void {
    if (!overlay.enabled) return;

    const xyz = (v: THREE.Vector3) => `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
    const h = overlay.lastHit;

    overlay.text.textContent =
        `pos     ${xyz(camera.position)}\n` +
        `target  ${xyz(controls.target)}\n` +
        `hit     ${h ? xyz(h) : '-'}\n` +
        `fire    int ${fire.intensity.toFixed(2)}  pulse ${fire.pulse.toFixed(2)}\n` +
        `splats  ${splatCount.toLocaleString()}  (render x${perf.renderScale.toFixed(2)})`;
}

/* controls */

function row(...children: (Node | string)[]): HTMLLabelElement {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    label.append(...children);
    return label;
}

function input(type: string, props: Record<string, string | boolean> = {}): HTMLInputElement {
    const el = document.createElement('input');
    // In order: a range's value has to come after its min and max, or it's clamped to 0..100.
    for (const [key, value] of Object.entries({ type, ...props })) Object.assign(el, { [key]: value });
    return el;
}

function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
    const box = input('checkbox', { checked });
    box.addEventListener('change', () => onChange(box.checked));
    return row(box, label);
}

/** A checkbox that arms an override, and its 0..1 value: reports null while unarmed. */
function heatSlider(onChange: (value: number | null) => void): HTMLLabelElement {
    const armed = input('checkbox');
    const slider = input('range', { min: '0', max: '1', step: '0.01', value: '0' });
    slider.style.width = '90px';
    const emit = () => onChange(armed.checked ? Number(slider.value) : null);
    armed.addEventListener('change', emit);
    slider.addEventListener('input', emit);
    return row(armed, 'fire heat', slider);
}

function range(
    label: string,
    { min, max, step, value }: { min: number; max: number; step: number; value: number },
    onChange: (value: number) => void,
): HTMLLabelElement {
    const slider = input('range', { min: String(min), max: String(max), step: String(step), value: String(value) });
    slider.style.width = '80px';
    const readout = document.createElement('span');
    readout.textContent = value.toFixed(2);
    slider.addEventListener('input', () => {
        readout.textContent = Number(slider.value).toFixed(2);
        onChange(Number(slider.value));
    });
    return row(label, slider, readout);
}
