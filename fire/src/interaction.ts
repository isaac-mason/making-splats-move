// Pointer interaction: click or tap anywhere to throw another log on the fire — it
// flares, the clearing brightens, the air shimmers harder and embers burst out.
//
// Deliberately a *tap*, not any pointerdown: OrbitControls owns dragging, so we only
// stoke when the pointer barely moved and was down only briefly. Otherwise every
// orbit of the camera would also feed the fire.

const TAP_MOVE_PX = 6; // a press that travels further than this is an orbit drag
const TAP_MS = 400; // … and one held longer than this isn't a tap either

export type InteractionOptions = {
    /** Called on a tap. */
    onStoke: () => void;
    /** Optional gate — return false to swallow taps (e.g. while the debug panel owns clicks). */
    enabled?: () => boolean;
};

export function attachInteraction(canvas: HTMLElement, { onStoke, enabled }: InteractionOptions): void {
    let downX = 0;
    let downY = 0;
    let downT = 0;
    let tracking = false;

    canvas.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary) return;
        downX = event.clientX;
        downY = event.clientY;
        downT = event.timeStamp;
        tracking = true;
    });

    canvas.addEventListener('pointercancel', () => {
        tracking = false;
    });

    canvas.addEventListener('pointerup', (event) => {
        if (!tracking || !event.isPrimary) return;
        tracking = false;

        if (event.timeStamp - downT > TAP_MS) return;
        if (Math.hypot(event.clientX - downX, event.clientY - downY) > TAP_MOVE_PX) return;
        if (enabled && !enabled()) return;

        onStoke();
    });
}
