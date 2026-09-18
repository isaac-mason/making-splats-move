import type { SparkRenderer } from '@sparkjsdev/spark';
import type * as THREE from 'three';
import type { Reveal } from './reveal';

/**
 * The debug panel the other examples have: backtick to toggle, click-to-copy
 * coordinates, and — since the whole thing is over in two seconds — a button to
 * watch it again without reloading 96MB.
 */

export type DebugOverlay = {
    element: HTMLDivElement;
    enabled: boolean;
    fields: {
        cam: HTMLSpanElement;
        look: HTMLSpanElement;
        splats: HTMLSpanElement;
        radius: HTMLSpanElement;
        fps: HTMLSpanElement;
    };
};

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

export function createDebugOverlay(onReplay: () => void): DebugOverlay {
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
    const radiusRow = createReadoutRow('front');
    const fpsRow = createReadoutRow('frame');
    makeCopyable(camRow.value);
    makeCopyable(lookRow.value);
    text.append(camRow.row, lookRow.row, splatsRow.row, radiusRow.row, fpsRow.row);

    const replay = document.createElement('button');
    replay.type = 'button';
    replay.textContent = 'replay reveal';
    replay.style.cssText = 'font:inherit;color:#0f0;background:#022;border:1px solid #0a0;cursor:pointer;padding:3px';
    replay.addEventListener('click', onReplay);

    element.append(text, replay);
    document.body.append(element);

    const overlay: DebugOverlay = {
        element,
        enabled: false,
        fields: {
            cam: camRow.value,
            look: lookRow.value,
            splats: splatsRow.value,
            radius: radiusRow.value,
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
    reveal: Reveal,
    dt: number,
): void {
    if (!overlay.enabled) return;
    const p = camera.position;
    const f = overlay.fields;
    f.cam.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    f.look.textContent = `${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}`;
    f.splats.textContent = `${spark.activeSplats.toLocaleString()} active`;
    f.radius.textContent = `${reveal.radius.toFixed(1)} m`;
    f.fps.textContent = `${(dt * 1000).toFixed(1)} ms`;
}
