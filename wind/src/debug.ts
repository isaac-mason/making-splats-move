import type { SparkRenderer } from '@sparkjsdev/spark';
import type * as THREE from 'three';

import type { Performance } from './performance';

export type DebugOverlay = {
    element: HTMLDivElement;
    /** Container holding the readout rows. */
    text: HTMLDivElement;
    /** Per-line value spans updated each frame; the coord ones are click-to-copy. */
    fields: {
        cam: HTMLSpanElement;
        look: HTMLSpanElement;
        splats: HTMLSpanElement;
    };
    /** Whether the text panel is shown (toggled with the backtick key). */
    enabled: boolean;
    /** Whether wind edit mode is on (toggled by the checkbox). */
    editWind: boolean;
    /**
     * Free-look. Off by default: the shipped camera is the fixed framing plus the
     * parallax lean (src/camera-drift.ts), because that's the shot. Orbiting is a
     * tool for framing and for authoring wind volumes, not a feature of the scene.
     */
    orbit: boolean;
    /** Called when the edit-mode checkbox flips; index.ts hooks the wind editor up here. */
    onEditWind?: (enabled: boolean) => void;
    /** Called when the wind checkbox flips; index.ts turns the wind on and off here. */
    onWindEnabled?: (enabled: boolean) => void;
    /** Called when the highlight-leaves checkbox flips; index.ts hands it to the wind editor. */
    onHighlightLeaves?: (enabled: boolean) => void;
};

type Checkbox = {
    el: HTMLLabelElement;
    /** Tick/untick from code. Fires `onChange` too, so dependent state stays in step. */
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
// (toggle with the backtick `), the wind edit-mode switch, and the LOD budget
// sliders. The coordinate rows are click-to-copy, so orbiting to a framing you like
// and pasting the values back into scene.ts is the authoring loop.
export type DebugOptions = {
    /**
     * Called when free-look is toggled. `false` means the presentation camera is
     * taking over again, which is the caller's cue to put it back where it belongs
     * — the orbit camera will have left it wherever the last drag ended.
     */
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

    // Readout rows. The Vec3 lines are click-to-copy — cam + look give you the orbit
    // camera's pose to paste straight back into scene.ts.
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
        // Authoring volumes means flying around to look at them, so edit mode
        // brings free-look with it rather than leaving you stuck in the framing
        // wondering why the camera won't move.
        if (checked) orbitCheckbox.set(true);
        overlay.onEditWind?.(checked);
    });

    const highlightCheckbox = createCheckbox('highlight leaves', (checked) => overlay.onHighlightLeaves?.(checked));
    highlightCheckbox.set(true);

    const lodSlider = createRange('lod scale', { min: 0.2, max: 2, step: 0.05, value: perf.lodScale }, (value) => {
        perf.lodScale = value;
    });

    // Min on-screen splat size (px). Higher = fewer tiny splats = lower active count.
    const renderScaleSlider = createRange('lod px', { min: 1, max: 5, step: 0.25, value: perf.lodRenderScale }, (value) => {
        perf.lodRenderScale = value;
    });

    element.append(
        orbitCheckbox.el,
        windCheckbox.el,
        windEditCheckbox.el,
        highlightCheckbox.el,
        lodSlider,
        renderScaleSlider,
        overlay.text,
    );
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
    spark: SparkRenderer,
): void {
    if (!overlay.enabled) return;

    const p = camera.position;
    const active = spark.activeSplats.toLocaleString();
    const max = spark.maxSplats.toLocaleString();
    const f = overlay.fields;
    f.cam.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    f.look.textContent = `${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}`;
    f.splats.textContent = `${active} / ${max}  (lod x${spark.lodSplatScale.toFixed(2)})`;
}
