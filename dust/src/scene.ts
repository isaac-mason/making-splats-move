import * as THREE from 'three';
import greenhouseUrl from '../assets/greenhouse.spz?url';

export type Vec3 = [number, number, number];

export const SPLAT_URL = greenhouseUrl;

export const SPLAT_SCALE = 3;

export const CAMERA_POSITION: Vec3 = [-0.26, 3.4, 6.47];
export const CAMERA_TARGET: Vec3 = [0, 2.5, -6];

export const DUST_BOX = new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 9, 10));
