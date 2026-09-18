import * as THREE from 'three';

/**
 * Everything the URL can say, read once.
 *
 * The same shape as avatars/'s options: a plain object parsed at startup, rather
 * than an accessor that re-reads the query string from inside the frame loop.
 */

export type Options = {
    /** `?cam=x,y,z` / `?look=x,y,z` override the framing. */
    cam: THREE.Vector3 | null;
    look: THREE.Vector3 | null;
    /** `?origin=x,y,z` moves the point the ripple spreads out from. */
    origin: THREE.Vector3 | null;
    /** `?t=1.2` freezes the wavefront at one moment, in seconds. */
    frozenTime: number | null;
};

export function readOptions(search = window.location.search): Options {
    const params = new URLSearchParams(search);
    const vector = (key: string) => {
        const parts = params.get(key)?.split(',').map(Number);
        return parts?.length === 3 && parts.every(Number.isFinite) ? new THREE.Vector3(...parts) : null;
    };
    const raw = params.get('t');

    return {
        cam: vector('cam'),
        look: vector('look'),
        origin: vector('origin'),
        frozenTime: raw === null || raw === '' ? null : Number(raw),
    };
}
