import type { SparkRenderer } from '@sparkjsdev/spark';
import type * as THREE from 'three';

/**
 * The debug panel the other examples have: backtick to toggle, click-to-copy
 * coordinates, and a switch to take the dust away and see the room without it.
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
    /** Called when the dust checkbox flips. */
    onDustEnabled?: (enabled: boolean) => void;
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

export function createDebugOverlay({ onDustEnabled }: DebugOptions = {}): DebugOverlay {
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

    const dustCheckbox = createCheckbox('dust', true, (checked) => onDustEnabled?.(checked));

    element.append(dustCheckbox, text);
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
    spark: SparkRenderer,
    dt: number,
): void {
    if (!overlay.enabled) return;
    const p = camera.position;
    const f = overlay.fields;
    f.cam.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    f.look.textContent = `${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}`;
    f.splats.textContent = `${spark.activeSplats.toLocaleString()} active`;
    f.fps.textContent = `${(dt * 1000).toFixed(1)} ms`;
}
