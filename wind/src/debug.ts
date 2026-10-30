import type * as THREE from 'three';

import type { Performance } from './performance';

export type DebugOverlay = {
    element: HTMLDivElement;
    text: HTMLDivElement;
    fields: {
        cam: HTMLSpanElement;
        look: HTMLSpanElement;
        splats: HTMLSpanElement;
    };
    enabled: boolean;
    editWind: boolean;
    orbit: boolean;
    onEditWind?: (enabled: boolean) => void;
    onWindEnabled?: (enabled: boolean) => void;
    onHighlightLeaves?: (enabled: boolean) => void;
};

type Checkbox = {
    el: HTMLLabelElement;
    set(checked: boolean): void;
};

function createCheckbox(label: string, onChange: (checked: boolean) => void): Checkbox {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input, label);
    return {
        el: wrapper,
        set(checked) {
            if (input.checked === checked) return;
            input.checked = checked;
            onChange(checked);
        },
    };
}

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

function createReadoutRow(label: string): { row: HTMLDivElement; value: HTMLSpanElement } {
    const row = document.createElement('div');
    const lbl = document.createElement('span');
    lbl.textContent = label.padEnd(8);
    const value = document.createElement('span');
    row.style.cssText = 'white-space:pre';
    row.append(lbl, value);
    return { row, value };
}

function makeCopyable(value: HTMLSpanElement): void {
    value.style.cursor = 'pointer';
    value.title = 'click to copy';
    value.addEventListener('click', async () => {
        const text = value.textContent?.trim();
        if (!text || text === '-') return;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            return;
        }
        value.style.color = '#fff';
        setTimeout(() => {
            value.style.color = '';
        }, 500);
    });
}

export type DebugOptions = {
    onOrbitChange?: (orbit: boolean) => void;
};

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

    const text = document.createElement('div');
    text.style.cssText = 'display:flex;flex-direction:column';
    const camRow = createReadoutRow('cam');
    const lookRow = createReadoutRow('look');
    const splatsRow = createReadoutRow('splats');
    makeCopyable(camRow.value);
    makeCopyable(lookRow.value);
    text.append(camRow.row, lookRow.row, splatsRow.row);

    const overlay: DebugOverlay = {
        element,
        text,
        fields: {
            cam: camRow.value,
            look: lookRow.value,
            splats: splatsRow.value,
        },
        enabled: false,
        editWind: false,
        orbit: false,
    };

    const orbitCheckbox = createCheckbox('orbit camera', (checked) => {
        overlay.orbit = checked;
        onOrbitChange?.(checked);
    });

    const windCheckbox = createCheckbox('wind', (checked) => overlay.onWindEnabled?.(checked));
    windCheckbox.set(true);

    const windEditCheckbox = createCheckbox('wind edit mode', (checked) => {
        overlay.editWind = checked;
        if (checked) orbitCheckbox.set(true);
        overlay.onEditWind?.(checked);
    });

    const highlightCheckbox = createCheckbox('highlight leaves', (checked) => overlay.onHighlightLeaves?.(checked));
    highlightCheckbox.set(true);

    const renderScaleSlider = createRange('render scale', { min: 0.25, max: 1, step: 0.05, value: perf.renderScale }, (value) => {
        perf.renderScale = value;
    });

    element.append(orbitCheckbox.el, windCheckbox.el, windEditCheckbox.el, highlightCheckbox.el, renderScaleSlider, overlay.text);
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
    splatCount: number,
    perf: Performance,
): void {
    if (!overlay.enabled) return;

    const p = camera.position;
    const f = overlay.fields;
    f.cam.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    f.look.textContent = `${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}`;
    f.splats.textContent = `${splatCount.toLocaleString()}  (render x${perf.renderScale.toFixed(2)})`;
}
