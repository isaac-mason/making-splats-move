import * as THREE from 'three';

/** `?cam=x,y,z` style overrides, for framing a shot without editing and reloading. */
const params = new URLSearchParams(window.location.search);

export const url = {
    vector(key: string): THREE.Vector3 | null {
        const parts = params.get(key)?.split(',').map(Number);
        return parts?.length === 3 && parts.every(Number.isFinite) ? new THREE.Vector3(...parts) : null;
    },
    number(key: string): number | null {
        const raw = params.get(key);
        return raw === null || raw === '' ? null : Number(raw);
    },
};
