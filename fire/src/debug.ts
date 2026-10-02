import type { SparkRenderer } from '@sparkjsdev/spark';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { Fire } from './fire';
import type { Performance } from './performance';

export type DebugOverlay = {
    element: HTMLDivElement;
    text: HTMLDivElement;
    /** Whether the panel is shown (toggled with the backtick key). */
    enabled: boolean;
    /** Whether the SDF light wireframes are drawn (toggled by the checkbox). */
    showLights: boolean;
    /** Whether the flame generator is drawn. */
    fireEnabled: boolean;
    /** Whether the ember generator is drawn. */
    embersEnabled: boolean;
    /** Whether the firefly generator is drawn. */
    firefliesEnabled: boolean;
    /** Whether the smoke generator is drawn. */
    smokeEnabled: boolean;
    /** Whether the fire's SplatEdit lighting (hot core + clearing ambient) and point light apply. */
    lightingEnabled: boolean;
    /**
     * Free-look. Off by default: the shipped camera is the fixed framing plus the
     * parallax lean (src/camera-drift.ts), because that's the shot. Orbiting is a
     * tool for measuring the scene, not a feature of it.
     */
    orbit: boolean;
    /** Heat override: 0..1 forces all VFX to that heat, null = live. */
    heatOverride: number | null;
    /** Raycaster used for click-to-raycast against the scene. */
    raycaster: THREE.Raycaster;
    /** Marker placed at the last raycast hit point. Add to your scene. */
    raycastMarker: THREE.Mesh;
    /** World-space point of the last raycast hit, or null if nothing's been hit. */
    lastHit: THREE.Vector3 | null;
};

function createCheckbox(label: string, onChange: (checked: boolean) => void, checked = false): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input, label);
    return wrapper;
}

// A checkbox + range slider on one row. The checkbox arms the override; the
// slider value is reported via onChange only while armed (else `null` = live).
function createSlider(label: string, onChange: (value: number | null) => void): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '1';
    range.step = '0.01';
    range.value = '0';
    range.style.width = '90px';
    const emit = () => onChange(toggle.checked ? Number(range.value) : null);
    toggle.addEventListener('change', emit);
    range.addEventListener('input', emit);
    wrapper.append(toggle, label, range);
    return wrapper;
}

// An always-on labelled range slider that reports its value live, with a readout.
function createRange(
    label: string,
    opts: { min: number; max: number; step: number; value: number },
    onChange: (value: number) => void,
): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(opts.min);
    range.max = String(opts.max);
    range.step = String(opts.step);
    range.value = String(opts.value);
    range.style.width = '80px';
    const readout = document.createElement('span');
    readout.textContent = opts.value.toFixed(2);
    range.addEventListener('input', () => {
        const v = Number(range.value);
        readout.textContent = v.toFixed(2);
        onChange(v);
    });
    wrapper.append(label, range, readout);
    return wrapper;
}

export type DebugOptions = {
    /**
     * Called when free-look is toggled. `false` means the presentation camera is
     * taking over again, which is the caller's cue to put it back where it belongs
     * — the orbit camera will have left it wherever the last drag ended.
     */
    onOrbitChange?: (orbit: boolean) => void;
};

// Minimal debug overlay (plain DOM), toggled with backtick: camera readouts plus
// controls for the fire and LOD budget. While it's open, clicking raycasts the scene
// instead of stoking the fire — that's how the landmarks in scene.ts get measured.
export function createDebugOverlay(perf: Performance, { onOrbitChange }: DebugOptions = {}): DebugOverlay {
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

    // Marker drawn at the last raycast hit. Non-raycastable so clicks don't hit it.
    const raycastMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 16, 12),
        // transparent:true → draws in the transparent pass, after (and on top of) the
        // Spark splats; depthTest off + high renderOrder keeps it visible through geometry.
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
        heatOverride: null,
        raycaster: new THREE.Raycaster(),
        raycastMarker,
        lastHit: null,
    };

    const orbitCheckbox = createCheckbox('orbit camera', (checked) => {
        overlay.orbit = checked;
        onOrbitChange?.(checked);
    });

    const lightsCheckbox = createCheckbox('lights debug', (checked) => {
        overlay.showLights = checked;
    });

    const fireCheckbox = createCheckbox('fire', (checked) => (overlay.fireEnabled = checked), true);
    const embersCheckbox = createCheckbox('embers', (checked) => (overlay.embersEnabled = checked), true);
    const smokeCheckbox = createCheckbox('smoke', (checked) => (overlay.smokeEnabled = checked), true);
    const firefliesCheckbox = createCheckbox('fireflies', (checked) => (overlay.firefliesEnabled = checked), true);
    const lightingCheckbox = createCheckbox('lighting', (checked) => (overlay.lightingEnabled = checked), true);

    const heatSlider = createSlider('fire heat', (value) => {
        overlay.heatOverride = value;
    });

    const lodSlider = createRange('lod scale', { min: 0.2, max: 2, step: 0.05, value: perf.lodScale }, (value) => {
        perf.lodScale = value;
    });

    overlay.text.style.cssText = 'white-space:pre;user-select:text;-webkit-user-select:text;cursor:text';

    element.append(
        orbitCheckbox,
        lightsCheckbox,
        fireCheckbox,
        embersCheckbox,
        smokeCheckbox,
        firefliesCheckbox,
        lightingCheckbox,
        heatSlider,
        lodSlider,
        overlay.text,
    );
    document.body.appendChild(element);

    window.addEventListener('keydown', (event) => {
        if (event.key === '`') {
            overlay.enabled = !overlay.enabled;
            element.style.display = overlay.enabled ? 'flex' : 'none';
            // Raycast is a panel feature — hide its marker when the panel closes.
            if (!overlay.enabled) overlay.raycastMarker.visible = false;
        }
    });

    return overlay;
}

// Wire up click-to-raycast against the scene (e.g. the splat). On each click the
// marker jumps to the hit point and overlay.lastHit is updated.
export function attachDebugRaycast(
    overlay: DebugOverlay,
    camera: THREE.Camera,
    scene: THREE.Scene,
    domElement: HTMLElement,
): void {
    const ndc = new THREE.Vector2();

    domElement.addEventListener('click', (event) => {
        if (!overlay.enabled) return; // only raycast while the debug panel is open

        const rect = domElement.getBoundingClientRect();
        ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        overlay.raycaster.setFromCamera(ndc, camera);
        const hit = overlay.raycaster.intersectObjects(scene.children, true)[0];
        if (!hit) return;

        overlay.lastHit = hit.point.clone();
        overlay.raycastMarker.position.copy(hit.point);
        overlay.raycastMarker.visible = true;
    });
}

export function updateDebugOverlay(
    overlay: DebugOverlay,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    fire: Fire,
    spark: SparkRenderer,
): void {
    if (!overlay.enabled) return;

    const p = camera.position;
    const t = controls.target;
    const h = overlay.lastHit;
    const active = spark.activeSplats.toLocaleString();
    const max = spark.maxSplats.toLocaleString();

    overlay.text.textContent =
        `pos     ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}\n` +
        `target  ${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)}\n` +
        `hit     ${h ? `${h.x.toFixed(2)}, ${h.y.toFixed(2)}, ${h.z.toFixed(2)}` : '-'}\n` +
        `fire    int ${fire.intensity.toFixed(2)}  pulse ${fire.pulse.toFixed(2)}\n` +
        `splats  ${active} / ${max}  (lod x${spark.lodSplatScale.toFixed(2)})`;
}
