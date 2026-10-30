import * as THREE from 'three';

export type Options = {
    cam: THREE.Vector3 | null;
    look: THREE.Vector3 | null;
    origin: THREE.Vector3 | null;
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
