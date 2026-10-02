/**
 * Everything the avatars DO. Each walker is in exactly one state, and each state is
 * one function below:
 *
 *   walking  — steering about the walk area, posed by the gait
 *   pausing  — stood still a moment, looking about or at someone
 *   showing  — called to the front to be customised: runs there, then stands
 *   limp     — knocked down: physics owns the body, the pose is read out of it
 *   rising   — back on its feet, blending out of the sprawl it woke up in
 *
 * On top of that, each has a FACE (where they look, how they blink) and a
 * PERSONALITY, keyed by cast name, that tunes both.
 *
 * The gait rate is derived from leg length (`strideLength`), not chosen: any
 * constant and the feet slide.
 */

import type { World } from 'crashcat';
import * as THREE from 'three';
import { type Avatar, type Expression, HEAD, initAvatar, PELVIS, poseAvatar, pushAvatar, strideLength } from './avatar';
import { CAST } from './avatar-params';
import {
    bodyPosition,
    bodySpeed,
    disposePuppet,
    drivePuppet,
    goDriven,
    goLimp,
    initPuppet,
    type Puppet,
    readPuppet,
    setPuppetFrame,
} from './physics';
import {
    GROUND_Y,
    SHOWCASE_FACING,
    SHOWCASE_SPOT,
    WALK_CENTER,
    WALK_HALF_ACROSS,
    WALK_HALF_DEEP,
    walkLocal,
    walkWorld,
} from './scene';

const { randFloat } = THREE.MathUtils;

/* types */

export type WalkerState = 'walking' | 'pausing' | 'showing' | 'limp' | 'rising';

export type Walker = {
    avatar: Avatar;
    puppet: Puppet;
    state: WalkerState;
    /** On the ground plane. */
    position: THREE.Vector3;
    heading: number;
    targetHeading: number;
    speed: number;
    /** Gait phase in radians; 2π is two steps. */
    phase: number;
    /** 1 walking, 0 standing still. */
    gait: number;
    face: Face;
    /** Held by the pointer: nobody gets up mid-carry. */
    held: boolean;

    /* per-state bookkeeping */
    /** walking: seconds until a new direction, and until the next pause. */
    secondsUntilTurn: number;
    pauseIn: number;
    /** pausing: `toward` is a heading to turn to, or null to just look about. */
    pause: { t: number; duration: number; toward: number | null };
    /** limp: seconds on the floor. */
    downFor: number;
    /** rising: 0..1 through the get-up, blending out of this sprawl. */
    riseT: number;
    sprawlQuat: THREE.Quaternion[];
    sprawlPos: THREE.Vector3[];
};

export type Crowd = {
    walkers: Walker[];
    /** Off, they walk on the spot — for studying the gait. */
    moving: boolean;
};

/* constants */

/** Metres per second at which the authored gait looks natural. */
const REFERENCE_SPEED = 0.65;
/** Clearance above `feetY`: a splat is a soft disc, so exactly-on reads as sunk in. */
const FOOT_LIFT = 0.02;

// walking (seconds, metres, radians)
const TURN_RATE = 1.6;
const TURN_EVERY: [number, number] = [2.5, 6.0];
/** Closer than this and they steer round each other. */
const PERSONAL_SPACE = 1.4;
/** Back up to pace after standing. */
const RESUME_TIME = 0.5;

// pausing
const PAUSE_TIME: [number, number] = [1.8, 3.2];
/** How near, and how nearly in front, someone must be to be turned to. */
const NOTICE_REACH = 3;
const NOTICE_CONE = 1.1;

// showing, and standing still generally
/** Speed multiple out to the front. The gait rate follows speed, so it reads as a run. */
const SHOW_RUN = 3.0;
const SHOW_ARRIVED = 0.16;
/** Walk fading into a stance. */
const PARK_TIME = 0.4;
/** Phase rate stood still: nothing swings, it only drives the breathing. */
const BREATH_RATE = 1.5;
const SPIN_RATE = 4.5;

// limp and rising: lie there at least SETTLE_TIME and until still, but get up after
// MAX_DOWN_TIME regardless, in case they're wedged.
const SETTLE_TIME = 2.2;
const MAX_DOWN_TIME = 9;
const AT_REST_SPEED = 0.25;
const RISE_TIME = 0.9;
/** Still seeing stars this far through getting up. */
const DIZZY_UNTIL = 0.6;

/* personality */

type Personality = {
    /** Idle glances: how often, how far from `rest` (0..1), and where the eyes settle. */
    glanceEvery: [number, number];
    wander: number;
    rest: [number, number];
    /** Seconds they'll hold someone's eye before glancing away. */
    hold: number;
    /** How much of a look the head does rather than the eyes, 0..1. */
    headFollow: number;
    /** Per second. High reads as darting. */
    eyeSpeed: number;
    /** Metres within which someone is worth looking at. */
    notice: number;
    /** Seconds between blinks, how long one lasts, and the odds of a double. */
    blinkGap: [number, number];
    blinkTime: number;
    doubleBlink: number;
    /** Seconds between pauses, and the odds of turning to someone when they do. */
    pauseEvery: [number, number];
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

function personalityOf(name: string): Personality {
    return { ...BASE, ...PERSONALITIES[name] };
}

/* setup */

/** One of each of the cast (cycling, if `count` is larger). */
export function initCrowd(world: World, count: number, seed = 1): Crowd {
    const walkers: Walker[] = [];
    for (let i = 0; i < count; i++) {
        const params = CAST[i % CAST.length];
        const avatar = initAvatar(params, seed + i * 977);

        // A ring rather than a grid, so they don't read as a formation.
        const angle = (i / count) * Math.PI * 2 + 0.6;
        const [x, z] = walkWorld(Math.cos(angle) * WALK_HALF_ACROSS * 0.6, Math.sin(angle) * WALK_HALF_DEEP * 0.6);
        const position = new THREE.Vector3(x, GROUND_Y, z);
        const heading = angle + Math.PI * 0.5;

        walkers.push({
            avatar,
            puppet: initPuppet(world, avatar, footing(new THREE.Vector3(), position, avatar.feetY), heading, i),
            state: 'walking',
            position,
            heading,
            targetHeading: heading,
            // A spread of speeds: a crowd all moving at one pace reads as artificial.
            speed: REFERENCE_SPEED * (0.75 + ((i * 0.37) % 1) * 0.55),
            phase: i * 1.7,
            gait: 1,
            face: initFace(params.name),
            held: false,
            secondsUntilTurn: 1 + ((i * 0.53) % 1) * 3,
            pauseIn: 3 + Math.random() * 8,
            pause: { t: 0, duration: 0, toward: null },
            downFor: 0,
            riseT: 0,
            sprawlQuat: avatar.skeleton.bones.map(() => new THREE.Quaternion()),
            sprawlPos: avatar.skeleton.bones.map(() => new THREE.Vector3()),
        });
    }
    return { walkers, moving: true };
}

/** Swap in a rebuilt avatar, keeping position, heading and phase. The bodies are rebuilt too: they're sized from it. */
export function rebuildWalker(world: World, walker: Walker, index: number, avatar: Avatar): void {
    disposePuppet(world, walker.puppet);
    walker.avatar.dispose();
    walker.avatar = avatar;
    walker.puppet = initPuppet(world, avatar, standAt(scratch, walker), walker.heading, index);
    // New bodies start driven, so anyone down is back up; anyone else keeps their
    // state — above all someone being customised, who'd otherwise wander off.
    if (walker.state === 'limp' || walker.state === 'rising') {
        walker.state = 'walking';
        walker.gait = 1;
    }
}

/* commands */

/** Call this walker to the front to be looked at. */
export function showWalker(walker: Walker): void {
    if (walker.state === 'limp') return;
    if (walker.state === 'pausing') endPause(walker);
    walker.state = 'showing';
}

export function unshowWalker(walker: Walker): void {
    if (walker.state !== 'showing') return;
    walker.state = 'walking';
    walker.gait = 1;
    walker.targetHeading = walker.heading;
    walker.secondsUntilTurn = 0.4;
}

/** Knock someone down. Safe to call on someone already down. */
export function knockDown(world: World, walker: Walker): void {
    if (walker.state === 'pausing') endPause(walker);
    walker.state = 'limp';
    walker.downFor = 0;
    goLimp(world, walker.puppet);
}

/* each frame */

/** `viewer` is the camera: who they look at while being shown off or carried. */
export function updateCrowd(crowd: Crowd, world: World, dt: number, viewer: THREE.Vector3 | null = null): void {
    // Move everyone, then untangle them, then pose — so nobody is drawn standing
    // inside someone who's pushed out of them a moment later.
    for (const w of crowd.walkers) tick(crowd, world, w, dt);
    separate(crowd.walkers);
    for (const w of crowd.walkers) draw(crowd, w, dt, viewer);
}

function tick(crowd: Crowd, world: World, w: Walker, dt: number): void {
    switch (w.state) {
        case 'walking':
            walk(crowd, w, dt);
            break;
        case 'pausing':
            linger(w, dt);
            break;
        case 'showing':
            present(w, dt);
            break;
        case 'limp':
            settle(world, w, dt);
            break;
        case 'rising':
            rise(w, dt);
            break;
    }
}

function draw(crowd: Crowd, w: Walker, dt: number, viewer: THREE.Vector3 | null): void {
    w.avatar.expression = expressionFor(w, dt);
    updateFace(w, crowd.walkers, viewer, dt);

    if (w.state === 'limp') {
        // Physics owns the pose: read the bodies back into the frame they fell in.
        readPuppet(w.puppet, w.avatar.skeleton);
        pushAvatar(w.avatar);
        return;
    }

    standAt(w.avatar.mesh.position, w);
    w.avatar.mesh.rotation.y = w.heading;
    setPuppetFrame(w.puppet, w.avatar.mesh.position, w.heading);

    poseAvatar(w.avatar, w.phase, w.gait);
    if (w.state === 'rising') {
        // Blend the walk pose in over the sprawl they woke up in.
        const t = THREE.MathUtils.smoothstep(w.riseT, 0, 1);
        const { worldQuat, worldPos } = w.avatar.skeleton;
        for (let i = 0; i < worldQuat.length; i++) {
            worldQuat[i].slerp(w.sprawlQuat[i], 1 - t);
            worldPos[i].lerp(w.sprawlPos[i], 1 - t);
        }
    }
    pushAvatar(w.avatar);
    drivePuppet(w.puppet, w.avatar.skeleton, dt);
}

function expressionFor(w: Walker, dt: number): Expression {
    if (w.state === 'limp') return w.held ? 'scared' : 'dizzy';
    if (w.state === 'rising' && w.riseT < DIZZY_UNTIL) return 'dizzy';
    return blinking(w.face, dt) ? 'blink' : 'happy';
}

/* states */

const push = new THREE.Vector3();

/** walking: wander, steer round people, turn back at the edges, stop now and then. */
function walk(crowd: Crowd, w: Walker, dt: number): void {
    if (crowd.moving) {
        w.pauseIn -= dt;
        if (w.pauseIn <= 0) {
            startPause(crowd, w);
            linger(w, dt);
            return;
        }
    }
    w.gait = Math.min(1, w.gait + dt / RESUME_TIME);

    // Steer away from everyone too close. Steering the HEADING, not the position, is
    // what makes it look like a decision; shoving positions apart looks magnetic.
    push.set(0, 0, 0);
    for (const other of crowd.walkers) {
        // Someone on the floor is something to trip over, not walk around.
        if (other === w || other.state === 'limp') continue;
        const dx = w.position.x - other.position.x;
        const dz = w.position.z - other.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > PERSONAL_SPACE || dist < 1e-4) continue;
        const urgency = 1 - dist / PERSONAL_SPACE;
        push.x += (dx / dist) * urgency;
        push.z += (dz / dist) * urgency;
    }
    const crowding = Math.hypot(push.x, push.z);
    if (crowding > 1e-3) {
        // A brush past is a nudge, a head-on a swerve.
        w.targetHeading += wrap(Math.atan2(push.x, push.z) - w.targetHeading) * Math.min(1, crowding) * 0.6;
    }

    w.secondsUntilTurn -= dt;
    if (w.secondsUntilTurn <= 0) {
        w.targetHeading += (Math.random() - 0.5) * Math.PI * 1.1;
        w.secondsUntilTurn = randFloat(...TURN_EVERY);
    }

    // Turn back toward the middle near the edge; a hard reflection looks like a bug.
    const [across, deep] = walkLocal(w.position.x, w.position.z);
    if (Math.abs(across) > WALK_HALF_ACROSS * 0.85 || Math.abs(deep) > WALK_HALF_DEEP * 0.85) {
        w.targetHeading = Math.atan2(WALK_CENTER[0] - w.position.x, WALK_CENTER[2] - w.position.z);
    }

    if (crowd.moving) {
        turnToward(w, w.targetHeading, TURN_RATE, dt);
        w.position.x += Math.sin(w.heading) * w.speed * w.gait * dt;
        w.position.z += Math.cos(w.heading) * w.speed * w.gait * dt;
    }
    // One cycle is two steps, hence PI rather than 2PI.
    w.phase += ((Math.PI * w.speed) / strideLength(w.avatar.params)) * dt;
}

/** Stop: turn to whoever's in front, if the mood takes them, or just look about. */
function startPause(crowd: Crowd, w: Walker): void {
    const near = nearestInFront(crowd, w);
    const turning = near !== null && Math.random() < w.face.personality.greetChance;
    w.state = 'pausing';
    w.pause.t = 0;
    w.pause.duration = randFloat(...PAUSE_TIME);
    w.pause.toward = turning && near ? Math.atan2(near.position.x - w.position.x, near.position.z - w.position.z) : null;
}

/** pausing: ease into a stance, turning to them if that's the plan. */
function linger(w: Walker, dt: number): void {
    w.pause.t += dt;
    standStill(w, dt);
    if (w.pause.toward !== null) turnToward(w, w.pause.toward, SPIN_RATE, dt);
    w.targetHeading = w.heading;
    if (w.pause.t >= w.pause.duration) endPause(w);
}

function endPause(w: Walker): void {
    w.state = 'walking';
    w.pauseIn = randFloat(...w.face.personality.pauseEvery);
    w.secondsUntilTurn = 0.3;
}

/** showing: run to the front, then turn to face the camera and stand. */
function present(w: Walker, dt: number): void {
    const dx = SHOWCASE_SPOT[0] - w.position.x;
    const dz = SHOWCASE_SPOT[2] - w.position.z;
    const distance = Math.hypot(dx, dz);

    if (distance > SHOW_ARRIVED) {
        const speed = w.speed * SHOW_RUN;
        turnToward(w, Math.atan2(dx, dz), SPIN_RATE, dt);
        // Never overshoot the spot on a long frame.
        const step = Math.min(speed * dt, distance);
        w.position.x += Math.sin(w.heading) * step;
        w.position.z += Math.cos(w.heading) * step;
        w.phase += ((Math.PI * speed) / strideLength(w.avatar.params)) * dt;
        w.gait = 1;
        return;
    }

    turnToward(w, SHOWCASE_FACING, SPIN_RATE, dt);
    w.targetHeading = w.heading;
    standStill(w, dt);
}

const pelvis = new THREE.Vector3();
const head = new THREE.Vector3();

/**
 * limp: once they've stopped falling, stand them up where they landed.
 *
 * Move the mesh frame to where they'll stand FIRST, then read the bodies against it:
 * the sprawl then comes out in the same space as the walk pose, so the two just mix.
 */
function settle(world: World, w: Walker, dt: number): void {
    w.downFor += dt;
    if (w.held) return;
    const stillTumbling = bodySpeed(w.puppet.bodies[PELVIS]) > AT_REST_SPEED;
    if ((w.downFor < SETTLE_TIME || stillTumbling) && w.downFor < MAX_DOWN_TIME) return;

    // Up where they lie (kept inside the walk area), facing the way the body points.
    bodyPosition(pelvis, w.puppet.bodies[PELVIS]);
    bodyPosition(head, w.puppet.bodies[HEAD]);
    const [across, deep] = walkLocal(pelvis.x, pelvis.z);
    [w.position.x, w.position.z] = walkWorld(
        THREE.MathUtils.clamp(across, -WALK_HALF_ACROSS, WALK_HALF_ACROSS),
        THREE.MathUtils.clamp(deep, -WALK_HALF_DEEP, WALK_HALF_DEEP),
    );
    w.position.y = GROUND_Y;
    // Unless pelvis and head are stacked (curled up), when that direction is noise.
    if (Math.hypot(head.x - pelvis.x, head.z - pelvis.z) > 0.05) {
        w.heading = Math.atan2(head.x - pelvis.x, head.z - pelvis.z);
    }
    w.targetHeading = w.heading;

    goDriven(world, w.puppet);
    standAt(w.avatar.mesh.position, w);
    setPuppetFrame(w.puppet, w.avatar.mesh.position, w.heading);
    readPuppet(w.puppet, w.avatar.skeleton);
    for (let i = 0; i < w.sprawlQuat.length; i++) {
        w.sprawlQuat[i].copy(w.avatar.skeleton.worldQuat[i]);
        w.sprawlPos[i].copy(w.avatar.skeleton.worldPos[i]);
    }
    w.state = 'rising';
    w.riseT = 0;
}

/** rising: the blend itself happens in `draw`, over the freshly posed walk. */
function rise(w: Walker, dt: number): void {
    w.riseT = Math.min(1, w.riseT + dt / RISE_TIME);
    if (w.riseT >= 1) w.state = 'walking';
}

/* face */

type Face = {
    personality: Personality;
    /** The idle glance being held, and seconds until the next. */
    glance: THREE.Vector2;
    glanceIn: number;
    /** Who they're looking at, and for how long. */
    contact: Walker | 'viewer' | null;
    contactFor: number;
    /** Seconds left looking away after holding someone's eye too long. */
    shyFor: number;
    /** Seconds to the next blink; negative while shut. */
    blinkIn: number;
};

function initFace(name: string): Face {
    const personality = personalityOf(name);
    return {
        personality,
        glance: new THREE.Vector2(...personality.rest),
        glanceIn: Math.random() * 2,
        contact: null,
        contactFor: 0,
        shyFor: 0,
        blinkIn: randFloat(...personality.blinkGap),
    };
}

/** True while the eyes should be shut. */
function blinking(face: Face, dt: number): boolean {
    face.blinkIn -= dt;
    if (face.blinkIn < -face.personality.blinkTime) {
        face.blinkIn = Math.random() < face.personality.doubleBlink ? 0.12 : randFloat(...face.personality.blinkGap);
    }
    return face.blinkIn < 0;
}

/* looking */

/** Furthest the head turns, and what the eyes alone cover at full deflection (radians). */
const HEAD_YAW = 0.55;
const HEAD_PITCH = 0.3;
const EYE_YAW = 0.45;
const EYE_PITCH = 0.3;
/** Past this either side, a target is behind them. */
const BEHIND = 1.9;
/** Per second — always slower than the eyes, which is how people look at things. */
const HEAD_SPEED = 3.5;

const eye = new THREE.Vector3();
const target = new THREE.Vector3();
const wantGaze = new THREE.Vector2();
const wantLook = new THREE.Vector2();

/** Roughly where a walker's eyes are, in world space. */
function eyesOf(out: THREE.Vector3, w: Walker): THREE.Vector3 {
    const { skeleton, params } = w.avatar;
    const height = skeleton.bones[HEAD].tail.y - params.headRadius;
    return out.copy(w.avatar.mesh.position).setY(w.avatar.mesh.position.y + height);
}

/**
 * Aim the eyes and head — before posing, which reads the head turn. Look at the
 * camera if being shown off or carried, else the nearest person in front (fallen
 * ones included), else let the eyes wander.
 */
function updateFace(w: Walker, others: readonly Walker[], viewer: THREE.Vector3 | null, dt: number): void {
    const face = w.face;
    const p = face.personality;
    eyesOf(eye, w);

    /* what to look at */
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

    // Hold their eye for a while, then look away for a moment.
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

    /* where that puts the head and eyes */
    if (looking) {
        const yaw = yawTo(w, target);
        const flat = Math.hypot(target.x - eye.x, target.z - eye.z);
        const pitch = Math.atan2(target.y - eye.y, Math.max(flat, 1e-3));
        wantLook.set(
            THREE.MathUtils.clamp(yaw * p.headFollow, -HEAD_YAW, HEAD_YAW),
            THREE.MathUtils.clamp(pitch * p.headFollow, -HEAD_PITCH, HEAD_PITCH),
        );
        wantGaze.set(
            THREE.MathUtils.clamp((yaw - wantLook.x) / EYE_YAW, -1, 1),
            THREE.MathUtils.clamp((pitch - wantLook.y) / EYE_PITCH, -1, 1),
        );
    } else {
        face.glanceIn -= dt;
        if (face.glanceIn <= 0) {
            face.glanceIn = randFloat(...p.glanceEvery);
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * p.wander;
            face.glance.set(p.rest[0] + Math.cos(a) * r, p.rest[1] + Math.sin(a) * r * 0.6);
        }
        // Shy: down and to one side.
        if (face.shyFor > 0) face.glance.set(face.glance.x > 0 ? 0.7 : -0.7, -0.6);
        wantGaze.copy(face.glance).clampScalar(-1, 1);
        wantLook.set(wantGaze.x * EYE_YAW * p.headFollow * 0.4, wantGaze.y * EYE_PITCH * p.headFollow * 0.3);
    }

    w.avatar.gaze.lerp(wantGaze, 1 - Math.exp(-p.eyeSpeed * dt));
    w.avatar.look.lerp(wantLook, 1 - Math.exp(-HEAD_SPEED * dt));
}

/** Bearing of a point from the walker, relative to which way they face. +x is their left. */
function yawTo(w: Walker, point: THREE.Vector3): number {
    const dx = point.x - w.position.x;
    const dz = point.z - w.position.z;
    const c = Math.cos(w.heading);
    const s = Math.sin(w.heading);
    const x = dx * c - dz * s;
    const z = dx * s + dz * c;
    return Math.atan2(x, z);
}

/* helpers */

/** Wrap an angle into -PI..PI, for turning the shortest way round. */
function wrap(angle: number): number {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function turnToward(w: Walker, heading: number, rate: number, dt: number): void {
    w.heading += THREE.MathUtils.clamp(wrap(heading - w.heading), -rate * dt, rate * dt);
}

/**
 * Standing is not stopping: freeze the phase and they're caught mid-step. Fading
 * `gait` to zero lands on the rest stance; the phase keeps ticking for the breath.
 */
function standStill(w: Walker, dt: number): void {
    w.gait = Math.max(0, w.gait - dt / PARK_TIME);
    w.phase += BREATH_RATE * dt;
}

/** The nearest upright walker roughly in front, within reach. */
function nearestInFront(crowd: Crowd, w: Walker): Walker | null {
    let nearest: Walker | null = null;
    let best = NOTICE_REACH;
    for (const other of crowd.walkers) {
        if (other === w || other.state === 'limp') continue;
        const dx = other.position.x - w.position.x;
        const dz = other.position.z - w.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < best && Math.abs(wrap(Math.atan2(dx, dz) - w.heading)) < NOTICE_CONE) {
            best = dist;
            nearest = other;
        }
    }
    return nearest;
}

/**
 * Steering only nudges headings, so someone stood still or a head-on can still close
 * the gap. After everyone moves, push any overlapping pair apart, half each. The
 * fallen are physics' business; someone being shown stays put.
 */
function separate(walkers: readonly Walker[]): void {
    for (let a = 0; a < walkers.length; a++) {
        const wa = walkers[a];
        if (wa.state === 'limp' || wa.state === 'showing') continue;
        for (let b = a + 1; b < walkers.length; b++) {
            const wb = walkers[b];
            if (wb.state === 'limp' || wb.state === 'showing') continue;
            const dx = wb.position.x - wa.position.x;
            const dz = wb.position.z - wa.position.z;
            const dist = Math.hypot(dx, dz);
            const min = girth(wa) + girth(wb);
            if (dist >= min || dist < 1e-6) continue;
            const apart = (min - dist) / 2 / dist;
            wa.position.x -= dx * apart;
            wa.position.z -= dz * apart;
            wb.position.x += dx * apart;
            wb.position.z += dz * apart;
        }
    }
}

/** Radius from above: the head, the widest thing on them. */
function girth(w: Walker): number {
    const p = w.avatar.params;
    return p.headRadius * p.headWidth * p.hairThickness;
}

const scratch = new THREE.Vector3();

/**
 * Where the MESH goes for a ground point: lifted by its sole height. In one place
 * because the bodies must be built at exactly the origin the splats are drawn at.
 */
function footing(out: THREE.Vector3, position: THREE.Vector3, feetY: number): THREE.Vector3 {
    return out.copy(position).setY(position.y - feetY + FOOT_LIFT);
}

function standAt(out: THREE.Vector3, w: Walker): THREE.Vector3 {
    return footing(out, w.position, w.avatar.feetY);
}
