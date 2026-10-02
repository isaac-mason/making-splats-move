/**
 * Tap anywhere to throw a log on the fire. A *tap*, not any press: a press that
 * travels or lingers is someone orbiting the camera, not stoking.
 */

const TAP_MOVE_PX = 6;
const TAP_MS = 400;

export type InteractionOptions = {
    onStoke: () => void;
    /** Return false to swallow taps (while the debug panel owns clicks). */
    enabled?: () => boolean;
};

export function attachInteraction(canvas: HTMLElement, { onStoke, enabled }: InteractionOptions): void {
    let down: PointerEvent | null = null;

    canvas.addEventListener('pointerdown', (event) => {
        if (event.isPrimary) down = event;
    });
    canvas.addEventListener('pointercancel', () => {
        down = null;
    });
    canvas.addEventListener('pointerup', (event) => {
        if (!down || !event.isPrimary) return;
        const { clientX, clientY, timeStamp } = down;
        down = null;

        if (event.timeStamp - timeStamp > TAP_MS) return;
        if (Math.hypot(event.clientX - clientX, event.clientY - clientY) > TAP_MOVE_PX) return;
        if (enabled && !enabled()) return;
        onStoke();
    });
}
