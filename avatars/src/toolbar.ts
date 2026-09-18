/**
 * The tool picker, bottom centre.
 *
 * Three things want the same pointer and mean different things by it: customize
 * opens a walker's sliders on a click, grab knocks one down and carries it on a
 * drag, camera hands the drag to the orbit controls. One pointer can't serve all
 * three, so the mode is explicit and always on screen.
 */

export type Tool = 'customize' | 'grab' | 'camera';

export type Toolbar = {
    element: HTMLDivElement;
    tool: Tool;
};

/** Inline so there's no icon font to load and nothing to 404 on. */
const ICONS: Record<Tool, string> = {
    customize: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" width="21" height="21">
        <line x1="4" y1="7" x2="20" y2="7"/><circle cx="10" cy="7" r="2.4" fill="currentColor" stroke="none"/>
        <line x1="4" y1="13" x2="20" y2="13"/><circle cx="16" cy="13" r="2.4" fill="currentColor" stroke="none"/>
        <line x1="4" y1="19" x2="20" y2="19"/><circle cx="8" cy="19" r="2.4" fill="currentColor" stroke="none"/>
    </svg>`,
    camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
        stroke-linecap="round" stroke-linejoin="round" width="21" height="21">
        <path d="M3 8.5a2 2 0 0 1 2-2h2.3l1.3-2h6.8l1.3 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <circle cx="12" cy="12.5" r="3.4"/>
    </svg>`,
    grab: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
        stroke-linecap="round" stroke-linejoin="round" width="21" height="21">
        <path d="M9 11V5.4a1.4 1.4 0 0 1 2.8 0V11"/>
        <path d="M11.8 10.6V4.3a1.4 1.4 0 0 1 2.8 0v6.3"/>
        <path d="M14.6 11V6.2a1.4 1.4 0 0 1 2.8 0V14a6 6 0 0 1-6 6h-.7a5 5 0 0 1-3.8-1.8l-3-3.6a1.4 1.4 0 0 1 2-1.9L9 14.4V11"/>
    </svg>`,
};

const LABELS: Record<Tool, string> = {
    customize: 'customize',
    grab: 'grab',
    camera: 'camera',
};

const TOOLS: Tool[] = ['customize', 'grab', 'camera'];

export function initToolbar(onChange?: (tool: Tool) => void): Toolbar {
    const element = document.createElement('div');
    element.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:22px',
        'transform:translateX(-50%)',
        'display:flex',
        'gap:4px',
        'padding:5px',
        'border-radius:999px',
        'background:rgba(22,24,30,0.72)',
        'backdrop-filter:blur(10px)',
        '-webkit-backdrop-filter:blur(10px)',
        'box-shadow:0 6px 24px rgba(0,0,0,0.28)',
        'font:12px/1 system-ui,sans-serif',
        'user-select:none',
        'z-index:1000',
    ].join(';');

    const toolbar: Toolbar = { element, tool: 'customize' };
    const buttons = new Map<Tool, HTMLButtonElement>();

    const paint = () => {
        for (const [tool, button] of buttons) {
            const on = tool === toolbar.tool;
            button.style.background = on ? '#f4f5f7' : 'transparent';
            button.style.color = on ? '#16181e' : 'rgba(255,255,255,0.72)';
        }
    };

    for (const tool of TOOLS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = LABELS[tool];
        button.setAttribute('aria-label', LABELS[tool]);
        button.innerHTML = ICONS[tool];
        button.style.cssText = [
            'display:grid',
            'place-items:center',
            'width:42px',
            'height:38px',
            'border:0',
            'border-radius:999px',
            'cursor:pointer',
            'color:inherit',
            'transition:background 120ms,color 120ms,transform 120ms',
        ].join(';');
        button.addEventListener('pointerenter', () => {
            button.style.transform = 'translateY(-2px)';
        });
        button.addEventListener('pointerleave', () => {
            button.style.transform = '';
        });
        button.addEventListener('click', () => {
            if (toolbar.tool === tool) return;
            toolbar.tool = tool;
            paint();
            onChange?.(tool);
        });
        buttons.set(tool, button);
        element.append(button);
    }

    paint();
    document.body.append(element);
    return toolbar;
}

/** Say with the cursor which tool is live, so the gesture is guessable. */
export function setToolCursor(domElement: HTMLElement, tool: Tool, dragging = false): void {
    if (tool === 'grab') domElement.style.cursor = dragging ? 'grabbing' : 'grab';
    else if (tool === 'camera') domElement.style.cursor = 'move';
    else domElement.style.cursor = '';
}
