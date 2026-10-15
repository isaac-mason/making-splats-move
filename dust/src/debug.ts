import type * as THREE from 'three';
import type { Performance } from './performance';

/**
 * The debug panel the other examples have: backtick to toggle, click-to-copy
 * coordinates, a switch to take the dust away and see the room without it, and
 * one to add a THREE.Points version alongside to see why the motes are splats.
 */

export type DebugOverlay = {
    element: HTMLDivElement;
    enabled: boolean;
    fields: {
        cam: HTMLSpanElement;
        look: HTMLSpanElement;
        splats: HTMLSpanElement;
        fps: HTMLSpanElement;
    };
};

export type DebugOptions = {
    /** The live quality settings the render scale slider edits. */
    perf: Performance;
    /** Called when the splat dust checkbox flips. */
    onDustEnabled?: (enabled: boolean) => void;
    /** Called when the THREE.Points comparison checkbox flips. */
    onPointsEnabled?: (enabled: boolean) => void;
};

function createCheckbox(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input, label);
    return wrapper;
}

function createReadoutRow(label: string): { row: HTMLDivElement; value: HTMLSpanElement } {
    const row = document.createElement('div');
    row.style.cssText = 'white-space:pre';
    const name = document.createElement('span');
    name.textContent = label.padEnd(8);
    const value = document.createElement('span');
    row.append(name, value);
    return { row, value };
}

function createRange(
    label: string,
    { min, max, step, value }: { min: number; max: number; step: number; value: number },
    onChange: (value: number) => void,
): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const input = document.createElement('input');
    // In order: a range's value has to come after its min and max, or it's clamped to 0..100.
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.style.width = '80px';
    const readout = document.createElement('span');
    readout.textContent = value.toFixed(2);
    input.addEventListener('input', () => {
        readout.textContent = Number(input.value).toFixed(2);
        onChange(Number(input.value));
    });
    wrapper.append(label, input, readout);
    return wrapper;
}

/** Copy a readout to the clipboard on click, and flash to confirm. */
function makeCopyable(value: HTMLSpanElement): void {
    value.style.cursor = 'pointer';
    value.title = 'click to copy';
    value.addEventListener('click', async () => {
        const text = value.textContent?.trim();
        if (!text || text === '-') return;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            return; // clipboard blocked (insecure context) — nothing to flash
        }
        value.style.color = '#fff';
        setTimeout(() => {
            value.style.color = '';
        }, 500);
    });
}

export function createDebugOverlay({ perf, onDustEnabled, onPointsEnabled }: DebugOptions): DebugOverlay {
    const element = document.createElement('div');
    element.style.cssText = [
        'position:fixed',
        'top:8px',
        'left:8px',
        'padding:6px 8px',
        'display:none',
        'flex-direction:column',
        'gap:6px',
        'font:12px/1.4 monospace',
        'color:#0f0',
        'background:rgba(0,0,0,0.6)',
        'z-index:1000',
    ].join(';');

    const text = document.createElement('div');
    text.style.cssText = 'display:flex;flex-direction:column';
    const camRow = createReadoutRow('cam');
    const lookRow = createReadoutRow('look');
    const splatsRow = createReadoutRow('splats');
    const fpsRow = createReadoutRow('frame');
    makeCopyable(camRow.value);
    makeCopyable(lookRow.value);
    text.append(camRow.row, lookRow.row, splatsRow.row, fpsRow.row);

    const dustCheckbox = createCheckbox('splat dust', true, (checked) => onDustEnabled?.(checked));

    const pointsCheckbox = createCheckbox('THREE.Points dust (no depth)', false, (checked) => onPointsEnabled?.(checked));

    const renderScale = createRange('render scale', { min: 0.25, max: 1, step: 0.05, value: perf.renderScale }, (value) => {
        perf.renderScale = value;
    });

    element.append(dustCheckbox, pointsCheckbox, renderScale, text);
    document.body.append(element);

    const overlay: DebugOverlay = {
        element,
        enabled: false,
        fields: {
            cam: camRow.value,
            look: lookRow.value,
            splats: splatsRow.value,
            fps: fpsRow.value,
        },
    };

    window.addEventListener('keydown', (event) => {
        if (event.key === '`') {
            overlay.enabled = !overlay.enabled;
            element.style.display = overlay.enabled ? 'flex' : 'none';
        }
    });

    return overlay;
}

export function updateDebugOverlay(
    overlay: DebugOverlay,
    camera: THREE.PerspectiveCamera,
    target: THREE.Vector3,
    splatCount: number,
    dt: number,
): void {
    if (!overlay.enabled) return;
    const p = camera.position;
    const f = overlay.fields;
    f.cam.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    f.look.textContent = `${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}`;
    f.splats.textContent = `${splatCount.toLocaleString()} drawn`;
    f.fps.textContent = `${(dt * 1000).toFixed(1)} ms`;
}
