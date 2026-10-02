import {
    AVATAR_GROUPS,
    AVATAR_RANGES,
    type AvatarParams,
    avatarLabel,
    type Bundle,
    DEFAULT_AVATAR,
    STYLES,
    type Style,
} from './avatar-params';

/**
 * The character editor, in the spirit of a Mii maker rather than a tuning panel.
 *
 * You PICK things more than you tune them: each part has a handful of hand-made
 * styles drawn as little pictures, colours are swatches from the Mii palettes, and
 * the only sliders left are "how much" ones with no numbers on them. Forty-five raw
 * sliders are still here, behind the cog, along with the JSON to paste back into
 * source — that's a tool for whoever is tuning the code, not for dressing a person.
 *
 * Each style is a bundle of parameters, and its picture is drawn FROM that bundle, so
 * a tile can't promise something it doesn't do. A tile shows as selected when the
 * avatar matches it exactly; nudge a slider and you're in between styles, which is
 * fine.
 *
 * The rebuild timing is the whole performance problem — see updateAvatarEditor.
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

/** Anything that shows part of `params` and has to follow it when it changes. */
type Control = { sync(): void };

type Numeric = Record<string, number>;
// --- The palettes, from the Mii editor ------------------------------------------

const SKIN = ['#ffd3ae', '#fec58e', '#ffb56a', '#ffbfa6', '#ffaa8d', '#de7941', '#ad5128', '#8c3c23', '#632c18', '#3b2d22'];
const HAIR = ['#000000', '#402011', '#5c180b', '#7b3a14', '#4f3e10', '#885818', '#d0a04b', '#787880'];
const EYES = ['#000000', '#6c7071', '#663c2c', '#605d30', '#4554a7', '#397158'];
const SHIRTS = [
    '#d31e15',
    '#fd6f19',
    '#ffd920',
    '#78d320',
    '#007830',
    '#0a49b3',
    '#3caadf',
    '#f55a7c',
    '#7428ae',
    '#483817',
    '#e0e0e0',
    '#181914',
];
const TROUSERS = ['#3f4148', '#2a3550', '#4a5f82', '#8a7458', '#1d1d22', '#d8d2c4'];
const SHOES = ['#2a2a2e', '#5a3a24', '#e8e4dc', '#b0283a'];

// --- Look ----------------------------------------------------------------------

const STYLE_ID = 'avatar-editor-style';
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Nunito:wght@600;700;800&display=swap';
const CSS = `
.av-panel {
    --accent: #ff7a59; --on-accent: #fff;
    --ink: #3b3346; --soft: #8b8398; --line: #efe8dd; --card: #fffdf9; --well: #f6f0e7;
    position: fixed; top: 16px; right: 16px; bottom: 16px; width: 304px;
    display: none; flex-direction: column; overflow: hidden;
    border-radius: 26px; background: var(--card);
    box-shadow: 0 18px 50px rgba(40, 28, 20, 0.22), 0 0 0 1px rgba(40, 28, 20, 0.05);
    font: 600 13px/1.35 Nunito, ui-rounded, system-ui, sans-serif; color: var(--ink);
    z-index: 1000;
}
/* Font only: a colour here would outrank every button's own. */
.av-panel button { font: inherit; }

.av-head { display: flex; align-items: center; gap: 8px; padding: 18px 18px 6px; }
.av-name { flex: 1; font-size: 22px; font-weight: 800; letter-spacing: -0.01em; }
.av-name small { display: block; font-size: 12px; font-weight: 700; color: var(--soft); letter-spacing: 0; }
.av-icon-btn {
    width: 32px; height: 32px; display: grid; place-items: center; flex: none;
    border: 0; border-radius: 50%; cursor: pointer; background: var(--well); color: var(--soft);
    transition: background 120ms, color 120ms, transform 120ms;
}
.av-icon-btn:hover { color: var(--ink); transform: scale(1.06); }
.av-icon-btn.on { background: var(--accent); color: var(--on-accent); }

.av-tabs { display: flex; gap: 4px; padding: 8px 16px 10px; }
.av-tab {
    flex: 1; aspect-ratio: 1; max-width: 38px; display: grid; place-items: center;
    border: 0; border-radius: 14px; cursor: pointer; background: transparent; color: var(--soft);
    transition: background 140ms, color 140ms, transform 140ms;
}
.av-tab:hover { background: var(--well); color: var(--ink); }
.av-tab.on { background: var(--accent); color: var(--on-accent); transform: translateY(-1px); }
.av-tab svg { width: 20px; height: 20px; }

.av-body { flex: 1; overflow-y: auto; padding: 4px 18px 16px; scrollbar-width: thin; }
.av-page { display: none; }
.av-page.on { display: block; animation: av-in 180ms ease-out; }
@keyframes av-in { from { opacity: 0; transform: translateY(4px); } }
.av-page-title { font-size: 17px; font-weight: 800; margin: 2px 0 10px; }
.av-label { font-size: 11px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--soft); margin: 14px 0 8px; }

.av-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.av-tile {
    display: grid; justify-items: center; gap: 2px; padding: 8px 4px 7px;
    border: 0; border-radius: 16px; cursor: pointer; background: var(--well);
    box-shadow: inset 0 0 0 2px transparent;
    transition: transform 120ms, box-shadow 120ms, background 120ms;
}
.av-tile:hover { transform: translateY(-2px); }
.av-tile:active { transform: scale(0.94); }
.av-tile.on { background: #fff; box-shadow: inset 0 0 0 2.5px var(--accent), 0 4px 12px rgba(40, 28, 20, 0.08); }
.av-tile svg { width: 48px; height: 48px; }
.av-tile span { font-size: 11.5px; font-weight: 700; color: var(--soft); }
.av-tile.on span { color: var(--ink); }

.av-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
.av-swatch {
    width: 30px; height: 30px; border-radius: 50%; border: 0; cursor: pointer; padding: 0;
    box-shadow: inset 0 0 0 1.5px rgba(0, 0, 0, 0.12);
    transition: transform 120ms, box-shadow 120ms;
}
.av-swatch:hover { transform: scale(1.12); }
.av-swatch.on { box-shadow: 0 0 0 3px var(--card), 0 0 0 5.5px var(--accent); transform: scale(1.04); }

.av-slider { display: block; margin: 12px 0 4px; cursor: pointer; }
.av-slider-top { display: flex; justify-content: space-between; margin-bottom: 7px; }
.av-slider-ends { font-size: 11px; color: var(--soft); }
.av-panel input[type=range] {
    --pct: 50%;
    -webkit-appearance: none; appearance: none; width: 100%; height: 22px; margin: 0;
    background: transparent; cursor: pointer;
}
.av-panel input[type=range]::-webkit-slider-runnable-track {
    height: 10px; border-radius: 999px;
    background: linear-gradient(to right, var(--accent) var(--pct), var(--well) var(--pct));
}
.av-panel input[type=range]::-moz-range-track { height: 10px; border-radius: 999px; background: var(--well); }
.av-panel input[type=range]::-moz-range-progress { height: 10px; border-radius: 999px; background: var(--accent); }
.av-panel input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; margin-top: -6px; width: 22px; height: 22px;
    border-radius: 50%; background: #fff; border: 0;
    box-shadow: 0 2px 6px rgba(40, 28, 20, 0.25), inset 0 0 0 3px var(--accent);
    transition: transform 120ms;
}
.av-panel input[type=range]::-moz-range-thumb {
    width: 22px; height: 22px; border-radius: 50%; background: #fff; border: 0;
    box-shadow: 0 2px 6px rgba(40, 28, 20, 0.25), inset 0 0 0 3px var(--accent);
}
.av-panel input[type=range]:active::-webkit-slider-thumb { transform: scale(1.15); }

/* Fine-tune: the raw parameters, for whoever is tuning the code. */
.av-fine details { border-top: 1.5px solid var(--line); }
.av-fine summary { cursor: pointer; padding: 10px 0; font-weight: 800; list-style: none; }
.av-fine summary::-webkit-details-marker { display: none; }
.av-fine summary::after { content: '+'; float: right; color: var(--soft); }
.av-fine details[open] summary::after { content: '–'; }
.av-raw { display: block; padding: 3px 0 7px; }
.av-raw-top { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 2px; }
.av-raw-top span:last-child { font: 11px ui-monospace, monospace; color: var(--soft); }
.av-raw input[type=range] { height: 16px; }
.av-raw input[type=range]::-webkit-slider-runnable-track { height: 6px; }
.av-raw input[type=range]::-webkit-slider-thumb { width: 14px; height: 14px; margin-top: -4px; }
.av-json {
    width: 100%; height: 120px; box-sizing: border-box; padding: 8px; margin: 4px 0 8px;
    font: 10px/1.4 ui-monospace, monospace; color: var(--soft);
    background: var(--well); border: 0; border-radius: 12px; resize: vertical;
}

.av-foot { display: flex; gap: 8px; padding: 12px 18px 18px; }
.av-btn {
    flex: 1; padding: 11px; border: 0; border-radius: 999px; cursor: pointer;
    font-weight: 800; background: var(--well); color: var(--soft);
    transition: transform 120ms, filter 120ms;
}
.av-btn:hover { transform: translateY(-1px); color: var(--ink); }
.av-btn:active { transform: scale(0.96); }
.av-btn-primary { flex: 1.7; background: var(--accent); color: var(--on-accent); box-shadow: 0 6px 16px -6px var(--accent); }
.av-btn-primary:hover { color: var(--on-accent); filter: brightness(1.06); }
`;

function installStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = FONT_HREF;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(font, style);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

function button(className: string, html = ''): HTMLButtonElement {
    const b = element('button', className);
    b.type = 'button';
    b.innerHTML = html;
    return b;
}

// --- Icons -----------------------------------------------------------------------

const icon = (body: string) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
    head: icon(
        '<circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="11" r="0.6" fill="currentColor"/><circle cx="15" cy="11" r="0.6" fill="currentColor"/><path d="M9.5 15c1.4 1.2 3.6 1.2 5 0"/>',
    ),
    hair: icon('<path d="M4 15c0-6 3.5-10 8-10s8 4 8 10"/><path d="M7 11c2 1 6 1 10-2"/>'),
    eyes: icon('<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.6"/>'),
    brows: icon('<path d="M3 13c2-3 5-4 7-3"/><path d="M21 13c-2-3-5-4-7-3"/>'),
    mouth: icon('<path d="M5 10c3 5 11 5 14 0"/>'),
    body: icon('<circle cx="12" cy="5" r="2.5"/><path d="M8 21v-6l-2-1 1-5h10l1 5-2 1v6"/>'),
    clothes: icon('<path d="M8 4l-4 3 2 4 2-1v10h8V10l2 1 2-4-4-3c-1 1.5-2.4 2-4 2S9 5.5 8 4z"/>'),
    tune: icon('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
    close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
};

// --- Tile pictures, drawn from each style's own numbers ---------------------------

const INK = '#3b3346';
const SKIN_FILL = '#f6cfae';
let clipCount = 0;

function headPicture(s: Bundle): string {
    const rx = 15 * ((s.headWidth ?? 1) / 1.03);
    const ry = 15 * ((s.headHeight ?? 1) / 0.98);
    const chin = s.chinTaper ?? 0.2;
    // The lower half narrows with the chin taper, like the real head does.
    const lower = rx * (1 - chin * 0.55);
    return `<svg viewBox="0 0 48 48">
        <path d="M${24 - rx} 24 A${rx} ${ry} 0 0 1 ${24 + rx} 24 C${24 + rx} ${24 + ry * 0.6} ${24 + lower} ${24 + ry} 24 ${24 + ry} C${24 - lower} ${24 + ry} ${24 - rx} ${24 + ry * 0.6} ${24 - rx} 24 Z"
            fill="${SKIN_FILL}" stroke="${INK}" stroke-width="1.5"/>
        <circle cx="19" cy="24" r="1.6" fill="${INK}"/><circle cx="29" cy="24" r="1.6" fill="${INK}"/>
        <path d="M20.5 30c2 1.6 5 1.6 7 0" stroke="${INK}" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    </svg>`;
}

function hairPicture(s: Bundle): string {
    const id = `av-clip-${clipCount++}`;
    const cy = 26;
    const r = 12;
    // The fringe line and its teeth, across the forehead.
    const line = cy - r * ((s.fringeY ?? 0.58) - 0.15) * 1.1;
    const points = Math.max(1, Math.round(s.fringePoints ?? 4));
    const depth = r * (s.fringeDepth ?? 0.15) * 1.4;
    const sweep = (s.fringeSweep ?? 0) * 30;
    let zig = `M8 0 L8 ${line + sweep}`;
    for (let i = 0; i <= points * 2; i++) {
        const x = 8 + (32 * i) / (points * 2);
        const y = line + (i % 2 ? depth : 0) + sweep * (1 - (2 * i) / (points * 2));
        zig += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    zig += ' L40 0 Z';
    const length = s.hairLength ?? 0;
    const back =
        length > 0
            ? `<rect x="${24 - r - 2.5}" y="${cy - 4}" width="${2 * r + 5}" height="${10 + length * 9}" rx="6" fill="${INK}"/>`
            : '';
    const volume = r * (s.hairThickness ?? 1.13) * 0.92;
    return `<svg viewBox="0 0 48 48">
        <defs><clipPath id="${id}"><path d="${zig}"/></clipPath></defs>
        ${back}
        <circle cx="24" cy="${cy}" r="${r}" fill="${SKIN_FILL}"/>
        <circle cx="24" cy="${cy}" r="${volume}" fill="${INK}" clip-path="url(#${id})"/>
    </svg>`;
}

function eyePicture(s: Bundle): string {
    const size = (s.eyeSize ?? 0.16) / 0.16;
    const rx = Math.min(17, 11 * size * ((s.eyeWidth ?? 0.7) / 0.7) * 0.85);
    const ry = Math.min(17, 11 * size * (s.eyeTall ?? 1.05));
    const pupil = Math.min(rx, ry) * (s.pupilSize ?? 0.66);
    const shine = pupil * (s.eyeShine ?? 0.3) * 0.9;
    const outline = (s.eyeOutline ?? 0.08) > 0 ? 2 : 0;
    // A flatter top lid shows as the top of the eye cut flat.
    const flat = (s.eyeTopFlat ?? 2.2) > 2.6 ? 24 - ry * (1 - ((s.eyeTopFlat ?? 2.2) - 2.6) * 0.12) : 0;
    const id = `av-clip-${clipCount++}`;
    return `<svg viewBox="0 0 48 48">
        ${flat ? `<defs><clipPath id="${id}"><rect x="0" y="${flat}" width="48" height="48"/></clipPath></defs>` : ''}
        <g ${flat ? `clip-path="url(#${id})"` : ''}>
            <ellipse cx="24" cy="24" rx="${rx}" ry="${ry}" fill="#fff" stroke="${INK}" stroke-width="${outline}"/>
            <circle cx="24" cy="${24 + ry * 0.05}" r="${pupil}" fill="${INK}"/>
            ${shine > 0.4 ? `<circle cx="${24 + pupil * 0.38}" cy="${24 - pupil * 0.38}" r="${shine}" fill="#fff"/>` : ''}
        </g>
        ${flat ? `<line x1="${24 - rx}" y1="${flat}" x2="${24 + rx}" y2="${flat}" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>` : ''}
    </svg>`;
}

function browPicture(s: Bundle): string {
    const w = 30 * ((s.browWidth ?? 0.95) / 0.95);
    const h = Math.max(2, 26 * (s.browThickness ?? 0.14));
    const angle = (s.browAngle ?? 0.08) * 45;
    const round = Math.min(h / 2, 8 / Math.max(1, (s.browShape ?? 3) - 1));
    return `<svg viewBox="0 0 48 48">
        <rect x="${24 - w / 2}" y="${24 - h / 2}" width="${w}" height="${h}" rx="${round}"
            fill="${INK}" transform="rotate(${angle} 24 24)"/>
    </svg>`;
}

function mouthPicture(s: Bundle): string {
    const w = 90 * (s.mouthWidth ?? 0.16);
    const bend = 130 * (s.mouthCurve ?? 0.07);
    const thick = Math.max(2, 120 * (s.mouthThickness ?? 0.022));
    return `<svg viewBox="0 0 48 48">
        <path d="M${24 - w} ${24 - bend * 0.25} Q24 ${24 + bend} ${24 + w} ${24 - bend * 0.25}"
            stroke="${INK}" stroke-width="${thick}" fill="none" stroke-linecap="round"/>
    </svg>`;
}

function buildPicture(s: Bundle): string {
    const w = 110 * (s.torsoWidth ?? 0.15);
    const limb = 70 * (s.limbRadius ?? 0.06);
    const round = Math.min(w / 2, 14 / Math.max(1, (s.torsoRoundness ?? 2.8) - 1.4));
    return `<svg viewBox="0 0 48 48">
        <circle cx="24" cy="10" r="7" fill="${SKIN_FILL}" stroke="${INK}" stroke-width="1.5"/>
        <rect x="${24 - w / 2 - limb}" y="20" width="${limb}" height="13" rx="${limb / 2}" fill="${SKIN_FILL}"/>
        <rect x="${24 + w / 2}" y="20" width="${limb}" height="13" rx="${limb / 2}" fill="${SKIN_FILL}"/>
        <rect x="${24 - w / 2}" y="18" width="${w}" height="17" rx="${round}" style="fill: var(--accent)"/>
        <rect x="${24 - w / 2 + 1}" y="34" width="${w / 2 - 1.5}" height="11" rx="2" fill="${INK}"/>
        <rect x="${24 + 0.5}" y="34" width="${w / 2 - 1.5}" height="11" rx="2" fill="${INK}"/>
    </svg>`;
}

// --- Controls --------------------------------------------------------------------

type Context = { params: AvatarParams; changed: () => void; controls: Control[] };

function matches(params: AvatarParams, set: Bundle): boolean {
    const numeric = params as unknown as Numeric;
    return Object.entries(set).every(([key, value]) => Math.abs(numeric[key] - (value as number)) < 1e-6);
}

function tiles(ctx: Context, styles: Style[], picture: (s: Bundle) => string): HTMLDivElement {
    const grid = element('div', 'av-tiles');
    const buttons = styles.map((style) => {
        const tile = button('av-tile', `${picture(style.set)}<span>${style.name}</span>`);
        tile.addEventListener('click', () => {
            Object.assign(ctx.params, style.set);
            ctx.changed();
        });
        grid.append(tile);
        return tile;
    });
    ctx.controls.push({
        sync() {
            styles.forEach((style, i) => {
                buttons[i].classList.toggle('on', matches(ctx.params, style.set));
            });
        },
    });
    return grid;
}

function swatches(
    ctx: Context,
    key: 'skin' | 'hair' | 'eyes' | 'shirt' | 'trousers' | 'shoes',
    palette: string[],
): HTMLDivElement {
    const row = element('div', 'av-swatches');
    const chips = palette.map((colour) => {
        const chip = button('av-swatch');
        chip.style.background = colour;
        chip.title = colour;
        chip.addEventListener('click', () => {
            ctx.params[key] = colour;
            ctx.changed();
        });
        row.append(chip);
        return chip;
    });
    ctx.controls.push({
        sync() {
            const current = ctx.params[key].toLowerCase();
            palette.forEach((colour, i) => {
                chips[i].classList.toggle('on', colour.toLowerCase() === current);
            });
        },
    });
    return row;
}

/** A "how much" slider: words at the ends, no numbers. */
function slider(
    ctx: Context,
    opts: {
        label: string;
        ends: [string, string];
        min: number;
        max: number;
        get: (p: AvatarParams) => number;
        set: (p: AvatarParams, value: number) => void;
    },
): HTMLLabelElement {
    const wrap = element('label', 'av-slider');
    const top = element('div', 'av-slider-top');
    const name = element('span');
    name.textContent = opts.label;
    const ends = element('span', 'av-slider-ends');
    ends.textContent = `${opts.ends[0]} · ${opts.ends[1]}`;
    top.append(name, ends);
    const input = element('input');
    input.type = 'range';
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String((opts.max - opts.min) / 200);
    const paint = () => {
        const pct = ((Number(input.value) - opts.min) / (opts.max - opts.min)) * 100;
        input.style.setProperty('--pct', `${pct}%`);
    };
    input.addEventListener('input', () => {
        opts.set(ctx.params, Number(input.value));
        paint();
        ctx.changed();
    });
    ctx.controls.push({
        sync() {
            input.value = String(opts.get(ctx.params));
            paint();
        },
    });
    wrap.append(top, input);
    return wrap;
}

/** Slider over one parameter. */
const param = (key: keyof AvatarParams) => ({
    get: (p: AvatarParams) => (p as unknown as Numeric)[key],
    set: (p: AvatarParams, value: number) => {
        (p as unknown as Numeric)[key] = value;
    },
});

function label(text: string): HTMLDivElement {
    const node = element('div', 'av-label');
    node.textContent = text;
    return node;
}

function page(title: string, ...children: HTMLElement[]): HTMLDivElement {
    const node = element('div', 'av-page');
    const heading = element('div', 'av-page-title');
    heading.textContent = title;
    node.append(heading, ...children);
    return node;
}

/** Every raw parameter, with its number, plus the JSON to paste back into source. */
function finePage(ctx: Context, json: HTMLTextAreaElement, copy: HTMLButtonElement): HTMLDivElement {
    const node = page('Fine-tune');
    node.classList.add('av-fine');
    for (const spec of AVATAR_GROUPS) {
        const details = element('details');
        const summary = element('summary');
        summary.textContent = spec.title;
        details.append(summary);
        for (const key of spec.keys) {
            const range = AVATAR_RANGES[key];
            if (!range) continue;
            const [min, max, step] = range;
            const row = element('label', 'av-raw');
            row.title = key;
            const top = element('div', 'av-raw-top');
            const name = element('span');
            name.textContent = avatarLabel(key);
            const value = element('span');
            top.append(name, value);
            const input = element('input');
            input.type = 'range';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            const numeric = ctx.params as unknown as Numeric;
            const paint = () => {
                value.textContent = Number(input.value).toFixed(step < 0.01 ? 4 : step < 1 ? 3 : 0);
                input.style.setProperty('--pct', `${((Number(input.value) - min) / (max - min)) * 100}%`);
            };
            input.addEventListener('input', () => {
                numeric[key] = Number(input.value);
                paint();
                ctx.changed();
            });
            ctx.controls.push({
                sync() {
                    input.value = String(numeric[key]);
                    paint();
                },
            });
            row.append(top, input);
            details.append(row);
        }
        node.append(details);
    }
    const exported = element('details');
    const summary = element('summary');
    summary.textContent = 'JSON';
    exported.append(summary, json, copy);
    node.append(exported);
    return node;
}

/** Shirt colour as the panel's accent — unless it's too pale or dark to read. */
function accentFor(hex: string): { accent: string; on: string } {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma > 0.82 || luma < 0.08) return { accent: '#ff7a59', on: '#fff' };
    return { accent: hex, on: luma > 0.6 ? '#3b3346' : '#fff' };
}

// --- The editor ------------------------------------------------------------------

export function createAvatarEditor(
    onChange: (params: AvatarParams) => void,
    /** Called when the panel is dismissed — by Done, by the ×, or by Escape. */
    onClose?: () => void,
): AvatarEditor {
    installStyle();
    const params: AvatarParams = { ...DEFAULT_AVATAR };
    const controls: Control[] = [];
    // Reassigned once the editor object exists — the controls below close over it.
    let markDirty = () => {};
    const ctx: Context = {
        params,
        controls,
        changed: () => {
            markDirty();
            syncAll();
        },
    };

    const panel = element('div', 'av-panel');

    const head = element('div', 'av-head');
    const name = element('div', 'av-name');
    const fineButton = button('av-icon-btn', ICONS.tune);
    fineButton.title = 'Fine-tune';
    const close = button('av-icon-btn', ICONS.close);
    close.title = 'Close';
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
    head.append(name, fineButton, close);
    controls.push({
        sync() {
            name.innerHTML = '';
            name.append(params.name || 'Someone');
            const sub = element('small');
            sub.textContent = 'Make them yours';
            name.append(sub);
            const { accent, on } = accentFor(params.shirt);
            panel.style.setProperty('--accent', accent);
            panel.style.setProperty('--on-accent', on);
        },
    });

    // JSON, for pasting dialled-in numbers back into source.
    const json = element('textarea', 'av-json');
    json.readOnly = true;
    const copy = button('av-btn', 'Copy JSON');
    copy.style.width = '100%';

    const pages: { icon: string; title: string; node: HTMLDivElement }[] = [
        {
            icon: ICONS.head,
            title: 'Head',
            node: page(
                'Head',
                label('Shape'),
                tiles(ctx, STYLES.head, headPicture),
                slider(ctx, { label: 'Size', ends: ['small', 'big'], min: 0.26, max: 0.42, ...param('headRadius') }),
                label('Skin'),
                swatches(ctx, 'skin', SKIN),
            ),
        },
        {
            icon: ICONS.hair,
            title: 'Hair',
            node: page(
                'Hair',
                label('Style'),
                tiles(ctx, STYLES.hair, hairPicture),
                slider(ctx, { label: 'Volume', ends: ['flat', 'fluffy'], min: 1.04, max: 1.25, ...param('hairThickness') }),
                label('Colour'),
                swatches(ctx, 'hair', HAIR),
            ),
        },
        {
            icon: ICONS.eyes,
            title: 'Eyes',
            node: page(
                'Eyes',
                label('Shape'),
                tiles(ctx, STYLES.eyes, eyePicture),
                slider(ctx, { label: 'Spacing', ends: ['close', 'apart'], min: 0.18, max: 0.34, ...param('eyeSpacing') }),
                slider(ctx, { label: 'Height', ends: ['low', 'high'], min: -0.2, max: 0.1, ...param('eyeHeight') }),
                label('Colour'),
                swatches(ctx, 'eyes', EYES),
            ),
        },
        {
            icon: ICONS.brows,
            title: 'Brows',
            node: page(
                'Brows',
                label('Style'),
                tiles(ctx, STYLES.brows, browPicture),
                slider(ctx, { label: 'Height', ends: ['low', 'high'], min: 1.3, max: 2.4, ...param('browGap') }),
            ),
        },
        {
            icon: ICONS.mouth,
            title: 'Mouth',
            node: page(
                'Mouth',
                label('Style'),
                tiles(ctx, STYLES.mouth, mouthPicture),
                slider(ctx, { label: 'Height', ends: ['low', 'high'], min: -0.62, max: -0.32, ...param('mouthY') }),
                slider(ctx, { label: 'Nose', ends: ['none', 'button'], min: 0, max: 0.1, ...param('noseSize') }),
                slider(ctx, { label: 'Blush', ends: ['none', 'rosy'], min: 0, max: 0.9, ...param('blushStrength') }),
            ),
        },
        {
            icon: ICONS.body,
            title: 'Body',
            node: page(
                'Body',
                label('Build'),
                tiles(ctx, STYLES.build, buildPicture),
                // One "height" that scales legs, torso and arms together, so tall
                // people stay in proportion.
                slider(ctx, {
                    label: 'Height',
                    ends: ['short', 'tall'],
                    min: 0.82,
                    max: 1.18,
                    get: (p) => p.hipY / DEFAULT_AVATAR.hipY,
                    set: (p, s) => {
                        p.hipY = DEFAULT_AVATAR.hipY * s;
                        p.torsoHeight = DEFAULT_AVATAR.torsoHeight * s;
                        p.armLength = DEFAULT_AVATAR.armLength * (0.6 + 0.4 * s);
                    },
                }),
            ),
        },
        {
            icon: ICONS.clothes,
            title: 'Clothes',
            node: page(
                'Clothes',
                label('Favourite colour'),
                swatches(ctx, 'shirt', SHIRTS),
                label('Trousers'),
                swatches(ctx, 'trousers', TROUSERS),
                label('Shoes'),
                swatches(ctx, 'shoes', SHOES),
            ),
        },
    ];
    const fine = finePage(ctx, json, copy);

    const tabs = element('div', 'av-tabs');
    const body = element('div', 'av-body');
    const tabButtons: HTMLButtonElement[] = [];
    const show = (index: number) => {
        pages.forEach((p, i) => {
            p.node.classList.toggle('on', i === index);
            tabButtons[i].classList.toggle('on', i === index);
        });
        fine.classList.toggle('on', index < 0);
        fineButton.classList.toggle('on', index < 0);
        body.scrollTop = 0;
    };
    pages.forEach((p, i) => {
        const tab = button('av-tab', p.icon);
        tab.title = p.title;
        tab.addEventListener('click', () => show(i));
        tabButtons.push(tab);
        tabs.append(tab);
        body.append(p.node);
    });
    body.append(fine);
    fineButton.addEventListener('click', () => show(fine.classList.contains('on') ? 0 : -1));
    show(0);

    // Done is the primary action because it's also what puts the camera back.
    const foot = element('div', 'av-foot');
    const reset = button('av-btn', 'Reset');
    const done = button('av-btn av-btn-primary', 'Looks good!');
    done.addEventListener('click', dismiss);
    foot.append(reset, done);

    panel.append(head, tabs, body, foot);

    const refreshJson = () => {
        json.value = JSON.stringify(params, null, 2);
    };

    copy.addEventListener('click', () => {
        navigator.clipboard?.writeText(json.value).then(
            () => {
                copy.textContent = 'Copied!';
                setTimeout(() => {
                    copy.textContent = 'Copy JSON';
                }, 900);
            },
            () => json.select(),
        );
    });

    reset.addEventListener('click', () => {
        Object.assign(params, editor.baseline);
        ctx.changed();
    });

    document.body.append(panel);

    function syncAll() {
        for (const c of controls) c.sync();
    }

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
    syncAll();
    refreshJson();
    return editor;
}

/**
 * Call each frame. Rebuilds at most once, and only if something changed.
 *
 * Changing a parameter regenerates every splat, rebinds every bone weight and
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

/** Pull the controls back in line after something else has written `params`. */
export function syncAvatarEditor(editor: AvatarEditor): void {
    editor.baseline = { ...editor.params };
    for (const c of editor.controls) c.sync();
    editor.refreshJson();
}

export function setAvatarEditorVisible(editor: AvatarEditor, visible: boolean): void {
    editor.panel.style.display = visible ? 'flex' : 'none';
}
