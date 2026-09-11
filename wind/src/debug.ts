import type { SparkRenderer } from '@sparkjsdev/spark';
import * as THREE from 'three';

import type { Performance } from './performance';
import { WIND_SPHERES } from './wind';

export type DebugOverlay = {
    element: HTMLDivElement;
    /** Container holding the readout rows. */
    text: HTMLDivElement;
    /** Per-line value spans updated each frame; the coord ones are click-to-copy. */
    fields: {
        cam: HTMLSpanElement;
        look: HTMLSpanElement;
        hit: HTMLSpanElement;
        splats: HTMLSpanElement;
    };
    /** Whether the text panel is shown (toggled with the backtick key). */
    enabled: boolean;
    /** Whether the authored wind spheres are drawn (toggled by the checkbox). */
    showWindSpheres: boolean;
    /** Wireframe spheres visualizing WIND_SPHERES (src/wind.ts). Add to your scene. */
    windSpheres: THREE.Group;
    /** Raycaster used for click-to-raycast against the scene. */
    raycaster: THREE.Raycaster;
    /** Marker placed at the last raycast hit point. Add to your scene. */
    raycastMarker: THREE.Mesh;
    /** World-space point of the last raycast hit, or null if nothing's been hit. */
    lastHit: THREE.Vector3 | null;
};

function createCheckbox(label: string, onChange: (checked: boolean) => void): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input, label);
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

// A monospace readout row: a fixed-width label followed by a value span. The
// caller updates `value.textContent` each frame.
function createReadoutRow(label: string): { row: HTMLDivElement; value: HTMLSpanElement } {
    const row = document.createElement('div');
    const lbl = document.createElement('span');
    lbl.textContent = label.padEnd(8); // align values (monospace + white-space:pre)
    const value = document.createElement('span');
    row.style.cssText = 'white-space:pre';
    row.append(lbl, value);
    return { row, value };
}

// Make a value span click-to-copy: copies its current text to the clipboard and
// briefly flashes white. Used for the Vec3 coordinate readouts.
function makeCopyable(value: HTMLSpanElement): void {
    value.style.cursor = 'pointer';
    value.title = 'click to copy';
    value.addEventListener('click', async () => {
        const text = value.textContent?.trim();
        if (!text || text === '-') return;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            return; // clipboard blocked (e.g. insecure context) — nothing to flash
        }
        // Flash via colour only; the per-frame textContent update leaves it intact.
        value.style.color = '#fff';
        setTimeout(() => {
            value.style.color = '';
        }, 500);
    });
}

// Minimal debug overlay (plain DOM): a readout of the camera pose and splat counts
// (toggle with the backtick `), the authored-wind-sphere wireframes, and the LOD
// budget sliders. The coordinate rows are click-to-copy, so orbiting to a framing
// you like and pasting the values back into scene.ts is the authoring loop.
export function createDebugOverlay(perf: Performance): DebugOverlay {
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

    // Wireframe spheres visualizing the authored wind volumes. Positions/radii are in
    // native splat units — the same space the modifier runs in, and (since the mesh is
    // unscaled here) world space too.
    const windSpheres = new THREE.Group();
    windSpheres.visible = false;
    // transparent:true so it renders in the post-opaque pass, *after* the
    // alpha-blended splats; depthTest/Write off + high renderOrder keep it drawn
    // on top of everything regardless of scene depth.
    const windSphereMat = new THREE.MeshBasicMaterial({
        color: 0x33ddff,
        wireframe: true,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    for (const s of WIND_SPHERES) {
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(s.radius, 20, 14), windSphereMat);
        sphere.position.set(s.center[0], s.center[1], s.center[2]);
        sphere.renderOrder = 999;
        sphere.raycast = () => {}; // don't let click-to-raycast hit the debug volume
        windSpheres.add(sphere);
    }

    // Marker drawn at the last raycast hit. Non-raycastable so clicks don't hit it.
    const raycastMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xff3366, depthTest: false, depthWrite: false, transparent: true }),
    );
    raycastMarker.visible = false;
    raycastMarker.renderOrder = 1000;
    raycastMarker.frustumCulled = false;
    raycastMarker.raycast = () => {};

    // Readout rows. The Vec3 lines (cam / look / hit) are click-to-copy — cam +
    // look give you the orbit camera's pose to paste back.
    const text = document.createElement('div');
    text.style.cssText = 'display:flex;flex-direction:column';
    const camRow = createReadoutRow('cam');
    const lookRow = createReadoutRow('look');
    const hitRow = createReadoutRow('hit');
    const splatsRow = createReadoutRow('splats');
    makeCopyable(camRow.value);
    makeCopyable(lookRow.value);
    makeCopyable(hitRow.value);
    text.append(camRow.row, lookRow.row, hitRow.row, splatsRow.row);

    const overlay: DebugOverlay = {
        element,
        text,
        fields: {
            cam: camRow.value,
            look: lookRow.value,
            hit: hitRow.value,
            splats: splatsRow.value,
        },
        enabled: false,
        showWindSpheres: false,
        windSpheres,
        raycaster: new THREE.Raycaster(),
        raycastMarker,
        lastHit: null,
    };

    const windSphereCheckbox = createCheckbox('wind sphere debug', (checked) => {
        overlay.showWindSpheres = checked;
        windSpheres.visible = checked;
    });

    const lodSlider = createRange('lod scale', { min: 0.2, max: 2, step: 0.05, value: perf.lodScale }, (value) => {
        perf.lodScale = value;
    });

    // Min on-screen splat size (px). Higher = fewer tiny splats = lower active count.
    const renderScaleSlider = createRange('lod px', { min: 1, max: 5, step: 0.25, value: perf.lodRenderScale }, (value) => {
        perf.lodRenderScale = value;
    });

    element.append(windSphereCheckbox, lodSlider, renderScaleSlider, overlay.text);
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
    target: THREE.Vector3,
    spark: SparkRenderer,
): void {
    if (!overlay.enabled) return;

    const p = camera.position;
    const h = overlay.lastHit;
    const active = spark.activeSplats.toLocaleString();
    const max = spark.maxSplats.toLocaleString();
    const f = overlay.fields;
    f.cam.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    f.look.textContent = `${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}`;
    f.hit.textContent = h ? `${h.x.toFixed(2)}, ${h.y.toFixed(2)}, ${h.z.toFixed(2)}` : '-';
    f.splats.textContent = `${active} / ${max}  (lod x${spark.lodSplatScale.toFixed(2)})`;
}
