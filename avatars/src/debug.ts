/**
 * The debug panel the other examples have: backtick to toggle, click a readout to
 * copy it. Tools for authoring the scene, not features of it.
 */

import type * as THREE from 'three';
import type { Crowd } from './crowd';

export type DebugOverlay = {
    element: HTMLDivElement;
    enabled: boolean;
    /** Freeze the crowd, to study a frame. */
    frozen: boolean;
    showBounds: boolean;
    /** Off shows the raw splats in their rest pose. */
    skinning: boolean;
    /** Off, they walk on the spot. */
    movement: boolean;
    leaves: boolean;
    sway: boolean;
    /** Tint what the trees' wind claims, to check the spheres against the trees. */
    swayTint: boolean;
    fields: {
        cam: HTMLSpanElement;
        look: HTMLSpanElement;
        splats: HTMLSpanElement;
        picked: HTMLSpanElement;
    };
    /** Index of the selected walker, or -1. */
    selected: number;
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

export function createDebugOverlay(): DebugOverlay {
    const element = document.createElement('div');
    element.style.cssText = [
        'position:fixed',
        'top:8px',
        'left:8px',
        'max-width:320px',
        'padding:6px 8px',
        'display:none',
        'flex-direction:column',
        'gap:4px',
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
    const pickedRow = createReadoutRow('picked');
    makeCopyable(camRow.value);
    makeCopyable(lookRow.value);
    text.append(camRow.row, lookRow.row, splatsRow.row, pickedRow.row);

    const overlay: DebugOverlay = {
        element,
        enabled: false,
        frozen: false,
        showBounds: false,
        skinning: true,
        movement: true,
        leaves: true,
        sway: true,
        swayTint: false,
        fields: { cam: camRow.value, look: lookRow.value, splats: splatsRow.value, picked: pickedRow.value },
        selected: -1,
    };

    const freeze = createCheckbox('freeze crowd', (checked) => {
        overlay.frozen = checked;
    });
    const bounds = createCheckbox('show walk bounds', (checked) => {
        overlay.showBounds = checked;
    });
    const skinning = createCheckbox('skinning', (checked) => (overlay.skinning = checked), true);
    const movement = createCheckbox('movement', (checked) => (overlay.movement = checked), true);
    const leaves = createCheckbox('leaves', (checked) => (overlay.leaves = checked), true);
    const sway = createCheckbox('tree sway', (checked) => (overlay.sway = checked), true);
    const swayTint = createCheckbox('tint sway', (checked) => (overlay.swayTint = checked));
    const hint = document.createElement('div');
    hint.style.cssText = 'opacity:0.5';
    hint.textContent = 'tools are on the bar at the bottom';

    element.append(freeze, bounds, skinning, movement, leaves, sway, swayTint, text, hint);
    document.body.appendChild(element);

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
    drawn: number,
    crowd: Crowd | null,
): void {
    if (!overlay.enabled) return;
    const p = camera.position;
    const f = overlay.fields;
    f.cam.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    f.look.textContent = `${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}`;
    // The avatars' share: they drive the sort time that ragdolls are sensitive to.
    let avatars = 0;
    for (const w of crowd?.walkers ?? []) avatars += w.avatar.count;
    f.splats.textContent = `${drawn.toLocaleString()} drawn${avatars ? ` · ${avatars.toLocaleString()} avatars` : ''}`;
    f.picked.textContent = overlay.selected >= 0 && crowd ? `walker ${overlay.selected} of ${crowd.walkers.length}` : '-';
}
