import { AVATAR_COLORS, AVATAR_GROUPS, AVATAR_RANGES, type AvatarParams, avatarLabel, DEFAULT_AVATAR } from './avatar-params';

/**
 * Live editor for the character, in the spirit of wind/'s volume editor: sliders,
 * immediate feedback, and a JSON box to paste the result back into source.
 *
 * Two things shape how it looks. It shows PLAIN-LANGUAGE names — `chestTaper` is the
 * right name in `avatar.ts` and noise in front of someone dragging a slider — and it
 * folds into groups, because forty-five sliders in one column is a wall rather than
 * a panel.
 *
 * The rebuild timing is the whole design problem — see updateAvatarEditor.
 */

export type AvatarEditor = {
    params: AvatarParams;
    /** Internals the free functions below drive; not meant for callers. */
    controls: Control[];
    panel: HTMLDivElement;
    /**
     * What Reset goes back to.
     *
     * Not DEFAULT_AVATAR: pointed at a member of the crowd, "reset" should undo YOUR
     * edits and give that walker back, not replace them with the stock character.
     * Captured by syncAvatarEditor, which is exactly the moment something else has
     * written `params`.
     */
    baseline: AvatarParams;
    dirty: boolean;
    rebuild(params: AvatarParams): void;
    refreshJson(): void;
};

/** Every control keeps the parameter it drives, so reset never has to guess. */
type Control = { key: string; input: HTMLInputElement; sync(): void };

/**
 * One injected stylesheet rather than inline styles on every node.
 *
 * Not a preference: a range input can only be restyled through `::-webkit-slider-
 * thumb` and friends, and a pseudo-element has no inline form. Once a stylesheet is
 * needed for the sliders it may as well carry the rest.
 */
const STYLE_ID = 'avatar-editor-style';
const CSS = `
.av-panel {
    position: fixed; top: 16px; right: 16px; bottom: 16px; width: 274px;
    display: none; flex-direction: column; overflow: hidden;
    border-radius: 16px; border: 1px solid rgba(255,255,255,0.07);
    background: rgba(18,20,26,0.82);
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    box-shadow: 0 12px 40px rgba(0,0,0,0.36);
    font: 12px/1.4 system-ui, -apple-system, sans-serif;
    color: #e8ebf2; z-index: 1000;
}
.av-head {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 14px 10px; border-bottom: 1px solid rgba(255,255,255,0.06);
}
.av-title { flex: 1; font-size: 13px; font-weight: 600; letter-spacing: 0.01em; }
.av-close {
    width: 24px; height: 24px; display: grid; place-items: center;
    border: 0; border-radius: 8px; cursor: pointer; font-size: 15px; line-height: 1;
    color: rgba(232,235,242,0.6); background: rgba(255,255,255,0.06);
}
.av-close:hover { color: #e8ebf2; background: rgba(255,255,255,0.12); }

.av-body { flex: 1; overflow-y: auto; padding: 4px 14px 12px; scrollbar-width: thin; }
.av-body::-webkit-scrollbar { width: 8px; }
.av-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 8px; }

.av-group { border-bottom: 1px solid rgba(255,255,255,0.05); }
.av-group:last-of-type { border-bottom: 0; }
.av-group > summary {
    display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none;
    padding: 10px 0 8px; font-size: 11px; font-weight: 600;
    letter-spacing: 0.07em; text-transform: uppercase; color: rgba(232,235,242,0.5);
}
.av-group > summary::-webkit-details-marker { display: none; }
.av-group > summary:hover { color: rgba(232,235,242,0.85); }
.av-chevron { transition: transform 140ms; opacity: 0.7; }
.av-group[open] .av-chevron { transform: rotate(90deg); }
.av-fields { padding-bottom: 8px; }

.av-row { display: block; padding: 5px 0; cursor: pointer; }
.av-row-top { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
.av-name { flex: 1; color: rgba(232,235,242,0.82); }
.av-value {
    font: 11px/1 ui-monospace, monospace; color: rgba(232,235,242,0.45);
    font-variant-numeric: tabular-nums;
}

.av-panel input[type=range] {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 14px; margin: 0; background: transparent; cursor: pointer;
}
.av-panel input[type=range]::-webkit-slider-runnable-track {
    height: 4px; border-radius: 999px; background: rgba(255,255,255,0.13);
}
.av-panel input[type=range]::-moz-range-track {
    height: 4px; border-radius: 999px; background: rgba(255,255,255,0.13);
}
.av-panel input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; margin-top: -5px;
    width: 14px; height: 14px; border-radius: 50%;
    background: #ef6a52; border: 2px solid #1a1d24;
    box-shadow: 0 1px 4px rgba(0,0,0,0.5); transition: transform 110ms;
}
.av-panel input[type=range]::-moz-range-thumb {
    width: 14px; height: 14px; border-radius: 50%;
    background: #ef6a52; border: 2px solid #1a1d24; box-shadow: 0 1px 4px rgba(0,0,0,0.5);
}
.av-panel input[type=range]:hover::-webkit-slider-thumb { transform: scale(1.18); }

.av-swatches { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; padding: 4px 0 10px; }
.av-swatch { display: grid; justify-items: center; gap: 5px; cursor: pointer; }
.av-swatch span { font-size: 10px; color: rgba(232,235,242,0.5); }
.av-swatch input[type=color] {
    width: 34px; height: 34px; padding: 0; cursor: pointer;
    border: 2px solid rgba(255,255,255,0.16); border-radius: 50%; background: none;
    transition: transform 110ms;
}
.av-swatch:hover input[type=color] { transform: scale(1.08); }
.av-swatch input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
.av-swatch input[type=color]::-webkit-color-swatch { border: 0; border-radius: 50%; }
.av-swatch input[type=color]::-moz-color-swatch { border: 0; border-radius: 50%; }

.av-json {
    width: 100%; height: 132px; box-sizing: border-box; margin-bottom: 4px; padding: 8px;
    font: 10px/1.4 ui-monospace, monospace; color: #9fb0c8;
    background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.07);
    border-radius: 8px; resize: vertical;
}

.av-foot {
    display: flex; gap: 8px; padding: 10px 14px;
    border-top: 1px solid rgba(255,255,255,0.06); background: rgba(0,0,0,0.14);
}
.av-btn {
    flex: 1; padding: 7px; font: inherit; font-weight: 500; cursor: pointer;
    color: #e8ebf2; background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 9px;
    transition: background 120ms;
}
.av-btn:hover { background: rgba(255,255,255,0.15); }
.av-foot .av-btn:first-child { flex: 1.5; }
.av-btn-primary { background: #ef6a52; border-color: #ef6a52; color: #14161c; }
.av-btn-primary:hover { background: #ff7c64; }
`;

const CHEVRON = `<svg class="av-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" width="11" height="11">
    <polyline points="9 5 16 12 9 19"/></svg>`;

function installStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

/** A named group that folds away, so forty-five sliders read as six things. */
function group(title: string, open: boolean): { details: HTMLDetailsElement; fields: HTMLDivElement } {
    const details = element('details', 'av-group');
    details.open = open;
    const summary = document.createElement('summary');
    summary.innerHTML = CHEVRON;
    summary.append(title);
    const fields = element('div', 'av-fields');
    details.append(summary, fields);
    return { details, fields };
}

function sliderRow(key: string): { row: HTMLLabelElement; value: HTMLSpanElement } {
    const row = element('label', 'av-row');
    const top = element('div', 'av-row-top');
    const name = element('span', 'av-name');
    name.textContent = avatarLabel(key);
    // The real parameter name is one hover away, for when you're reading the source
    // alongside the panel.
    row.title = key;
    const value = element('span', 'av-value');
    top.append(name, value);
    row.append(top);
    return { row, value };
}

export function createAvatarEditor(
    onChange: (params: AvatarParams) => void,
    /** Called when the panel is dismissed — by Done, by the ×, or by Escape. */
    onClose?: () => void,
): AvatarEditor {
    installStyle();
    const params: AvatarParams = { ...DEFAULT_AVATAR };
    // Reassigned once the editor object exists — the controls below close over it.
    let markDirty = () => {};

    const panel = element('div', 'av-panel');
    const controls: Control[] = [];

    const head = element('div', 'av-head');
    const title = element('div', 'av-title');
    title.textContent = 'Customize';
    const close = element('button', 'av-close');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'close';
    const dismiss = () => {
        panel.style.display = 'none';
        onClose?.();
    };
    close.addEventListener('click', dismiss);
    // Escape closes it, because by then the camera has travelled and the only way
    // back out to the scene is through this panel.
    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && panel.style.display !== 'none') dismiss();
    });
    head.append(title, close);

    const body = element('div', 'av-body');

    for (const spec of AVATAR_GROUPS) {
        const { details, fields } = group(spec.title, !spec.advanced);
        for (const key of spec.keys) {
            const range = AVATAR_RANGES[key];
            if (!range) continue;
            const [min, max, step] = range;
            const { row, value } = sliderRow(key);
            const input = document.createElement('input');
            input.type = 'range';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(params[key as keyof AvatarParams]);
            const show = () => {
                value.textContent = Number(input.value).toFixed(step < 0.01 ? 4 : step < 1 ? 3 : 0);
            };
            show();
            const numeric = params as unknown as Record<string, number>;
            input.addEventListener('input', () => {
                numeric[key] = Number(input.value);
                show();
                markDirty();
            });
            controls.push({
                key,
                input,
                sync() {
                    input.value = String(numeric[key]);
                    show();
                },
            });
            row.append(input);
            fields.append(row);
        }
        body.append(details);
    }

    // Colours as round chips rather than a column of bars: five of them fit on one
    // line, and a swatch says what it is without needing to be read.
    const colours = group('Colours', true);
    const swatches = element('div', 'av-swatches');
    for (const key of AVATAR_COLORS) {
        const swatch = element('label', 'av-swatch');
        const input = document.createElement('input');
        input.type = 'color';
        input.value = params[key];
        const name = document.createElement('span');
        name.textContent = avatarLabel(key);
        input.addEventListener('input', () => {
            params[key] = input.value;
            markDirty();
        });
        controls.push({
            key,
            input,
            sync() {
                input.value = params[key];
            },
        });
        swatch.append(input, name);
        swatches.append(swatch);
    }
    colours.fields.append(swatches);
    body.append(colours.details);

    // The point of the whole panel: get the dialled-in numbers back into source.
    const exported = group('JSON', false);
    const json = element('textarea', 'av-json');
    json.readOnly = true;
    const copy = element('button', 'av-btn');
    copy.type = 'button';
    copy.textContent = 'Copy JSON';
    exported.fields.append(json, copy);
    body.append(exported.details);

    // Done is the primary action because it's also what puts the camera back.
    const foot = element('div', 'av-foot');
    const done = element('button', 'av-btn av-btn-primary');
    done.type = 'button';
    done.textContent = 'Done';
    done.addEventListener('click', dismiss);
    const reset = element('button', 'av-btn');
    reset.type = 'button';
    reset.textContent = 'Reset';
    foot.append(done, reset);

    panel.append(head, body, foot);

    const refreshJson = () => {
        json.value = JSON.stringify(params, null, 2);
    };
    refreshJson();

    copy.addEventListener('click', () => {
        navigator.clipboard?.writeText(json.value).then(
            () => {
                copy.textContent = 'Copied';
                setTimeout(() => {
                    copy.textContent = 'Copy JSON';
                }, 900);
            },
            () => {
                exported.details.open = true;
                json.select();
            },
        );
    });

    reset.addEventListener('click', () => {
        Object.assign(params, editor.baseline);
        for (const c of controls) c.sync();
        markDirty();
    });

    document.body.append(panel);

    const editor: AvatarEditor = {
        params,
        controls,
        panel,
        baseline: { ...DEFAULT_AVATAR },
        dirty: false,
        rebuild: onChange,
        refreshJson,
    };
    markDirty = () => {
        editor.dirty = true;
    };
    return editor;
}

/**
 * Call each frame. Rebuilds at most once, and only if something changed.
 *
 * Changing a parameter regenerates ~160k splats, rebinds every bone weight and
 * recompiles the generator — far too slow to run on every `input` event while a
 * slider is dragged. So edits only mark the model dirty and the rebuild happens
 * here, which turns a drag from hundreds of rebuilds into one per displayed frame.
 */
export function updateAvatarEditor(editor: AvatarEditor): void {
    if (!editor.dirty) return;
    editor.dirty = false;
    editor.rebuild(editor.params);
    editor.refreshJson();
}

/** Pull the sliders back in line after something else has written `params`. */
export function syncAvatarEditor(editor: AvatarEditor): void {
    editor.baseline = { ...editor.params };
    for (const c of editor.controls) c.sync();
    editor.refreshJson();
}

export function setAvatarEditorVisible(editor: AvatarEditor, visible: boolean): void {
    editor.panel.style.display = visible ? 'flex' : 'none';
}
