import * as THREE from 'three';
import { HEAD } from './avatar';
import type { Walker } from './crowd';

/**
 * Where someone is looking, and how they blink — most of what gives a face a person
 * behind it.
 *
 * Each frame picks something to look at: you, if they're being shown off or carried;
 * otherwise whoever's nearest in front of them (fallen people very much included);
 * otherwise nothing, and the eyes wander. The head takes part of the turn and the
 * eyes the rest, which is how people look at things — eyes first, head after.
 *
 * How each of them does it is their PERSONALITY: how often they glance about, how
 * long they'll hold someone's eye, where their eyes rest, how they blink.
 */

export type Personality = {
    /** Seconds between idle glances. */
    glanceEvery: [number, number];
    /** How far an idle glance strays from rest, 0..1. */
    wander: number;
    /** Where the eyes settle with nothing to look at: x, y in -1..1. */
    rest: [number, number];
    /** Seconds they'll hold someone's eye before glancing away for a moment. */
    hold: number;
    /** How much of a look the head does rather than the eyes, 0..1. */
    headFollow: number;
    /** How fast the eyes get there, per second. High reads as darting. */
    eyeSpeed: number;
    /** How close someone has to be to be worth looking at, in metres. */
    notice: number;
    /** Seconds between blinks, how long one lasts, and the odds of a double. */
    blinkGap: [number, number];
    blinkTime: number;
    doubleBlink: number;
    /** Seconds between stopping for a moment to look about. */
    pauseEvery: [number, number];
    /** Odds they turn to face someone in front of them when they stop, 0..1. */
    greetChance: number;
};

const BASE: Personality = {
    glanceEvery: [1.2, 3],
    wander: 0.55,
    rest: [0, 0],
    hold: 2.5,
    headFollow: 0.55,
    eyeSpeed: 16,
    notice: 2.8,
    blinkGap: [2, 5],
    blinkTime: 0.14,
    doubleBlink: 0.12,
    pauseEvery: [7, 15],
    greetChance: 0.5,
};

/** By cast name. Anyone else gets BASE. */
const PERSONALITIES: Record<string, Partial<Personality>> = {
    // Easygoing; the default.
    Mo: {},
    // Shy: meets your eye, then looks down and away. Head stays put.
    Ada: { hold: 0.8, rest: [0, -0.45], headFollow: 0.3, wander: 0.35, greetChance: 0.15 },
    // Friendly: turns right round to look at you, and keeps looking.
    Kofi: { hold: 6, headFollow: 0.85, notice: 3.5, greetChance: 0.95 },
    // Dreamy: eyes drift up and about, slowly; long, lazy blinks.
    June: { rest: [0.15, 0.4], glanceEvery: [2.5, 5], eyeSpeed: 6, blinkTime: 0.22, wander: 0.7 },
    // Calm: unhurried everything.
    Gus: { glanceEvery: [3, 6], headFollow: 0.4, eyeSpeed: 7, blinkTime: 0.2, blinkGap: [3, 7], pauseEvery: [5, 10] },
    // Curious: never still — darting glances, quick head turns, double blinks.
    Pip: {
        glanceEvery: [0.4, 1.2],
        wander: 0.95,
        headFollow: 0.9,
        eyeSpeed: 30,
        doubleBlink: 0.4,
        notice: 4,
        pauseEvery: [4, 9],
        greetChance: 0.7,
    },
};

export function personalityOf(name: string): Personality {
    return { ...BASE, ...PERSONALITIES[name] };
}

export type Face = {
    personality: Personality;
    /** The idle glance being held, and how long until the next. */
    glance: THREE.Vector2;
    glanceIn: number;
    /** Who they're looking at, and for how long. */
    contact: Walker | 'viewer' | null;
    contactFor: number;
    /** Seconds left looking away after holding someone's eye too long. */
    shyFor: number;
    /** Seconds to the next blink; negative while the eyes are shut. */
    blinkIn: number;
};

export function initFace(name: string): Face {
    const personality = personalityOf(name);
    return {
        personality,
        glance: new THREE.Vector2(...personality.rest),
        glanceIn: Math.random() * 2,
        contact: null,
        contactFor: 0,
        shyFor: 0,
        blinkIn: between(personality.blinkGap),
    };
}

export function between([lo, hi]: [number, number]): number {
    return lo + Math.random() * (hi - lo);
}

/** True while the eyes should be shut. */
export function blinking(face: Face, dt: number): boolean {
    face.blinkIn -= dt;
    if (face.blinkIn < -face.personality.blinkTime) {
        // A quick second blink now and then, then the usual wait.
        face.blinkIn = Math.random() < face.personality.doubleBlink ? 0.12 : between(face.personality.blinkGap);
    }
    return face.blinkIn < 0;
}

/** Furthest the head will turn toward something, yaw and pitch, in radians. */
const HEAD_YAW = 0.55;
const HEAD_PITCH = 0.3;
/** Angle the eyes alone cover at full deflection, yaw and pitch. */
const EYE_YAW = 0.45;
const EYE_PITCH = 0.3;
/** Past this either side, a target is behind them and not worth turning for. */
const BEHIND = 1.9;
/** How fast the head follows, per second — always slower than the eyes. */
const HEAD_SPEED = 3.5;

const eye = new THREE.Vector3();
const target = new THREE.Vector3();
const wantGaze = new THREE.Vector2();
const wantLook = new THREE.Vector2();

/** Where a walker's eyes are, roughly, in world space. */
function eyesOf(out: THREE.Vector3, w: Walker): THREE.Vector3 {
    const { skeleton, params } = w.avatar;
    const height = skeleton.bones[HEAD].tail.y - params.headRadius;
    return out.copy(w.avatar.mesh.position).setY(w.avatar.mesh.position.y + height);
}

/**
 * Aim the eyes and head. Call before posing: the head turn is read by poseAvatar.
 * `viewer` is the camera — the thing to look at when they're being looked at.
 */
export function updateFace(w: Walker, others: readonly Walker[], viewer: THREE.Vector3 | null, dt: number): void {
    const face = w.face;
    const p = face.personality;
    eyesOf(eye, w);

    // --- What to look at ---------------------------------------------------------
    let want: Walker | 'viewer' | null = null;
    const beingShown = (w.state === 'showing' && w.gait < 0.5) || (w.state === 'limp' && w.held);
    if (beingShown && viewer) {
        want = 'viewer';
        target.copy(viewer);
    } else if (w.state !== 'limp') {
        let best = p.notice;
        for (const other of others) {
            if (other === w) continue;
            eyesOf(target, other);
            const dist = target.distanceTo(eye);
            if (dist >= best) continue;
            // In front of them only: nobody looks over their shoulder at a stranger.
            const yaw = yawTo(w, target);
            if (Math.abs(yaw) > BEHIND) continue;
            best = dist;
            want = other;
        }
        if (want) eyesOf(target, want);
    }

    // Eye contact, then — for some — a look away.
    if (want !== face.contact) {
        face.contact = want;
        face.contactFor = 0;
    }
    face.contactFor += dt;
    if (face.shyFor > 0) face.shyFor -= dt;
    else if (want && face.contactFor > p.hold) {
        face.shyFor = 0.8 + Math.random() * 1.5;
        face.contactFor = -face.shyFor;
    }
    const looking = want !== null && face.shyFor <= 0;

    // --- Where that puts the head and eyes ----------------------------------------
    if (looking) {
        const yaw = yawTo(w, target);
        const flat = Math.hypot(target.x - eye.x, target.z - eye.z);
        const pitch = Math.atan2(target.y - eye.y, Math.max(flat, 1e-3));
        // The head takes its share, then the eyes do the rest.
        wantLook.set(
            THREE.MathUtils.clamp(yaw * p.headFollow, -HEAD_YAW, HEAD_YAW),
            THREE.MathUtils.clamp(pitch * p.headFollow, -HEAD_PITCH, HEAD_PITCH),
        );
        wantGaze.set(
            THREE.MathUtils.clamp((yaw - wantLook.x) / EYE_YAW, -1, 1),
            THREE.MathUtils.clamp((pitch - wantLook.y) / EYE_PITCH, -1, 1),
        );
    } else {
        // Idle: hold a glance for a while, then pick another near where they rest.
        face.glanceIn -= dt;
        if (face.glanceIn <= 0) {
            face.glanceIn = between(p.glanceEvery);
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * p.wander;
            face.glance.set(p.rest[0] + Math.cos(a) * r, p.rest[1] + Math.sin(a) * r * 0.6);
        }
        // Looking away after eye contact: down and to one side.
        if (face.shyFor > 0) face.glance.set(face.glance.x > 0 ? 0.7 : -0.7, -0.6);
        wantGaze.copy(face.glance).clampScalar(-1, 1);
        // The head drifts a little after the eyes, but mostly faces front.
        wantLook.set(wantGaze.x * EYE_YAW * p.headFollow * 0.4, wantGaze.y * EYE_PITCH * p.headFollow * 0.3);
    }

    // Eyes get there fast — fast enough to read as a dart, not a pan. The head lags.
    w.avatar.gaze.lerp(wantGaze, 1 - Math.exp(-p.eyeSpeed * dt));
    w.avatar.look.lerp(wantLook, 1 - Math.exp(-HEAD_SPEED * dt));
}

/** Bearing of a point from the walker, relative to which way they face. +x is their left. */
function yawTo(w: Walker, point: THREE.Vector3): number {
    const dx = point.x - w.position.x;
    const dz = point.z - w.position.z;
    // Into their frame: the mesh is turned by `heading` about Y, facing +Z.
    const c = Math.cos(w.heading);
    const s = Math.sin(w.heading);
    const x = dx * c - dz * s;
    const z = dx * s + dz * c;
    return Math.atan2(x, z);
}
