import type { World } from 'crashcat';
import * as THREE from 'three';
import { type Avatar, type Expression, HEAD, initAvatar, PELVIS, poseAvatar, pushAvatar, strideLength } from './avatar';
import { type AvatarParams, CAST } from './avatar-params';
import { smoothstep } from './ease';
import { between, blinking, type Face, initFace, updateFace } from './gaze';
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

/**
 * A handful of avatars wandering a flat patch of ground, and falling over.
 *
 * The gait rate is DERIVED, not chosen: a leg is a pendulum, so how far one step
 * carries you falls out of leg length and swing amplitude (see `strideLength`). Any
 * constant instead and the feet slide.
 *
 * Every walker is physical the whole time, not just once knocked over. On its feet
 * the bodies are kinematic and follow the pose, which is what lets one walker boot
 * another across the square; going limp flips the same bodies to dynamic and
 * reverses which end of the pipe is the source.
 */

export type WalkerState =
    /** Upright, steering, posed by the gait. */
    | 'walking'
    /** Dynamic bodies, pose read out of them. */
    | 'limp'
    /** Back on its feet, blending out of the sprawl it woke up in. */
    | 'rising'
    /** Summoned to the front to be customized: runs out, then stands facing you. */
    | 'showing';

export type Walker = {
    avatar: Avatar;
    puppet: Puppet;
    state: WalkerState;
    /** Position on the ground plane, and which way it's facing. */
    position: THREE.Vector3;
    heading: number;
    /** Heading it's turning toward; re-rolled every so often. */
    targetHeading: number;
    speed: number;
    /** Gait phase in radians; 2xPI is one full cycle, i.e. two steps. */
    phase: number;
    secondsUntilTurn: number;
    /** Seconds spent limp, which is what decides when to get back up. */
    downFor: number;
    /** 0 to 1 through the get-up blend. */
    riseT: number;
    /** The sprawl being blended out of, in the standing mesh frame. */
    sprawlQuat: THREE.Quaternion[];
    sprawlPos: THREE.Vector3[];
    /** True while the pointer is holding them — nobody gets up mid-carry. */
    held: boolean;
    /** How much of the walk cycle is showing: 1 walking, 0 standing still. */
    gait: number;
    /** Where they're looking and how they blink — see gaze.ts. */
    face: Face;
    /** Stopped for a moment to look about; null while walking. */
    pause: Pause | null;
    /** Seconds until they next stop. */
    pauseIn: number;
};

/** A moment standing still, looking about — or at whoever's in front of them. */
type Pause = {
    t: number;
    duration: number;
    /** Heading to turn to — toward someone they've stopped to look at — or null to stay put. */
    toward: number | null;
};

export type Crowd = {
    walkers: Walker[];
    /** Whether walkers travel. Off, they walk on the spot — for studying the gait. */
    moving: boolean;
};

/** Metres per second at which the authored gait looks natural. */
const REFERENCE_SPEED = 0.65;
/** Clearance above `feetY`: a splat is a soft disc, so exactly-on reads as sunk in. */
const FOOT_LIFT = 0.02;
const TURN_RATE = 1.6; // radians per second
const TURN_EVERY = [2.5, 6.0]; // seconds between course changes
/** How close another walker has to get before you start going round them. */
const PERSONAL_SPACE = 1.4;

/** Lie there at least this long, however still. */
const SETTLE_TIME = 2.2;
/** ...and get up regardless after this, in case they're wedged and never settle. */
const MAX_DOWN_TIME = 9;
const AT_REST_SPEED = 0.25;
const RISE_TIME = 0.9;

/** Speed multiplier out to the front. Reads as a run: the gait rate follows speed. */
const SHOW_RUN = 3.0;
const SHOW_ARRIVED = 0.16;
const SHOW_PARK_TIME = 0.4;
/** Phase rate while parked. Nothing swings any more; it only drives the breathing. */
const SHOW_BREATH = 1.5;
const SHOW_TURN_RATE = 4.5;

export function initCrowd(world: World, count: number, seed = 1): Crowd {
    const walkers: Walker[] = [];
    for (let i = 0; i < count; i++) {
        const params: AvatarParams = CAST[i % CAST.length];
        const avatar = initAvatar(params, seed + i * 977);

        // A ring rather than a grid, so they don't read as a formation.
        const angle = (i / count) * Math.PI * 2 + 0.6;
        const [x, z] = walkWorld(Math.cos(angle) * WALK_HALF_ACROSS * 0.6, Math.sin(angle) * WALK_HALF_DEEP * 0.6);
        const position = new THREE.Vector3(x, GROUND_Y, z);
        const heading = angle + Math.PI * 0.5;
        const origin = soleOrigin(new THREE.Vector3(), position, avatar.feetY);

        walkers.push({
            avatar,
            puppet: initPuppet(world, avatar, origin, heading, i),
            state: 'walking',
            position,
            heading,
            targetHeading: heading,
            // A spread of speeds: a crowd all moving at one pace reads as artificial.
            speed: REFERENCE_SPEED * (0.75 + ((i * 0.37) % 1) * 0.55),
            phase: i * 1.7,
            secondsUntilTurn: 1 + ((i * 0.53) % 1) * 3,
            downFor: 0,
            riseT: 0,
            sprawlQuat: avatar.skeleton.bones.map(() => new THREE.Quaternion()),
            sprawlPos: avatar.skeleton.bones.map(() => new THREE.Vector3()),
            held: false,
            gait: 1,
            face: initFace(params.name),
            pause: null,
            pauseIn: 3 + Math.random() * 8,
        });
    }
    return { walkers, moving: true };
}

/**
 * Swap in a freshly built avatar without the walker noticing — position, heading and
 * gait phase all survive. So must its bodies, which were sized from the proportions
 * that just changed.
 */
export function rebuildWalker(world: World, walker: Walker, index: number, avatar: Avatar): void {
    disposePuppet(world, walker.puppet);
    walker.avatar.dispose();
    walker.avatar = avatar;
    walker.puppet = initPuppet(world, avatar, standAt(originScratch, walker), walker.heading, index);
    // The new bodies start driven, so anyone who was down is back on their feet.
    // Everyone else carries on as they were — above all someone being customised,
    // who is parked with the gait faded out. Knocking them back to 'walking' sends
    // them gliding off in their standing pose on every slider tick.
    if (walker.state === 'limp' || walker.state === 'rising') {
        walker.state = 'walking';
        walker.gait = 1;
    }
}

/** Call this walker to the front to be looked at. */
export function showWalker(walker: Walker): void {
    if (walker.state === 'limp') return;
    endPause(walker);
    walker.state = 'showing';
}

/** Send them back to wandering. */
export function unshowWalker(walker: Walker): void {
    if (walker.state !== 'showing') return;
    walker.state = 'walking';
    walker.gait = 1;
    walker.targetHeading = walker.heading;
    walker.secondsUntilTurn = 0.4;
}

/** Knock someone down. Safe to call on someone already down. */
export function knockDown(world: World, walker: Walker): void {
    endPause(walker);
    walker.state = 'limp';
    walker.downFor = 0;
    goLimp(world, walker.puppet);
}

/**
 * Where an avatar's MESH goes, given the ground position it stands at: lifted by its
 * own sole height, so any build stands ON the paving.
 *
 * In one place because the bodies must be built against exactly the origin the
 * splats are drawn at — drift between the two spawns a ragdoll hovering by it.
 */
function soleOrigin(out: THREE.Vector3, position: THREE.Vector3, feetY: number): THREE.Vector3 {
    return out.copy(position).setY(position.y - feetY + FOOT_LIFT);
}

function standAt(out: THREE.Vector3, w: Walker): THREE.Vector3 {
    return soleOrigin(out, w.position, w.avatar.feetY);
}

const originScratch = new THREE.Vector3();
const push = new THREE.Vector3();
const pelvis = new THREE.Vector3();
const head = new THREE.Vector3();

/** Still seeing stars this far through getting up. */
const DIZZY_UNTIL = 0.6;

/**
 * The face follows the state: scared while dangling from the pointer, dizzy on the
 * floor and for the first part of getting up, and otherwise happy, blinking now and
 * then — a face that never blinks reads as a mask.
 */
function expressionFor(w: Walker, dt: number): Expression {
    if (w.state === 'limp') return w.held ? 'scared' : 'dizzy';
    if (w.state === 'rising' && w.riseT < DIZZY_UNTIL) return 'dizzy';
    return blinking(w.face, dt) ? 'blink' : 'happy';
}

/** `viewer` is the camera: who they look at while being shown off or carried. */
/**
 * Keep walkers out of each other. Steering is the polite version — it turns them
 * aside — but it only nudges a heading, and someone stood still waving or a head-on
 * at walking pace can still close the gap. So after everyone has moved, any pair
 * closer than their two heads' widths is pushed apart, half each, along the line
 * between them. Fallen walkers are physics' business, and someone being shown off
 * stays on their mark.
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
            const push = (min - dist) / 2 / dist;
            wa.position.x -= dx * push;
            wa.position.z -= dz * push;
            wb.position.x += dx * push;
            wb.position.z += dz * push;
        }
    }
}

/** How wide a walker is from above: the head, which is the widest thing on them. */
function girth(w: Walker): number {
    const p = w.avatar.params;
    return p.headRadius * p.headWidth * p.hairThickness;
}

export function updateCrowd(crowd: Crowd, world: World, dt: number, viewer: THREE.Vector3 | null = null): void {
    // Move everyone first, then untangle them, then pose — so nobody is drawn
    // standing inside someone who was pushed out of them a moment later.
    for (const w of crowd.walkers) {
        if (w.state === 'walking') steer(crowd, w, dt);
        else if (w.state === 'limp') settle(world, w, dt);
        else if (w.state === 'showing') present(w, dt);
    }
    separate(crowd.walkers);

    for (const w of crowd.walkers) {
        w.avatar.expression = expressionFor(w, dt);
        updateFace(w, crowd.walkers, viewer, dt);

        if (w.state === 'limp') {
            // Physics owns the pose; the mesh stays wherever it was when they fell,
            // and the bodies are read back into that frame.
            readPuppet(w.puppet, w.avatar.skeleton);
            pushAvatar(w.avatar);
            continue;
        }

        standAt(w.avatar.mesh.position, w);
        w.avatar.mesh.rotation.y = w.heading;
        setPuppetFrame(w.puppet, w.avatar.mesh.position, w.heading);

        poseAvatar(w.avatar, w.phase, w.gait);
        if (w.state === 'rising') {
            w.riseT = Math.min(1, w.riseT + dt / RISE_TIME);
            const t = smoothstep(w.riseT);
            const { worldQuat, worldPos } = w.avatar.skeleton;
            for (let i = 0; i < worldQuat.length; i++) {
                worldQuat[i].slerp(w.sprawlQuat[i], 1 - t);
                worldPos[i].lerp(w.sprawlPos[i], 1 - t);
            }
            if (w.riseT >= 1) w.state = 'walking';
        }
        pushAvatar(w.avatar);
        drivePuppet(w.puppet, w.avatar.skeleton, dt);
    }
}

/**
 * Decide when someone on the floor has stopped falling, and stand them up where they
 * landed.
 *
 * The trick is ordering: move the mesh frame to where they're going to stand FIRST,
 * then read the bodies against that new frame. The sprawl comes out already in the
 * space the walk pose lives in, so the two can simply be mixed.
 */
function settle(world: World, w: Walker, dt: number): void {
    w.downFor += dt;
    if (w.held) return;
    const stillTumbling = bodySpeed(w.puppet.bodies[PELVIS]) > AT_REST_SPEED;
    const ready = w.downFor > SETTLE_TIME && !stillTumbling;
    if (!ready && w.downFor < MAX_DOWN_TIME) return;

    // Stand up where they came to rest, facing the way their body is pointing.
    bodyPosition(pelvis, w.puppet.bodies[PELVIS]);
    bodyPosition(head, w.puppet.bodies[HEAD]);
    const [across, deep] = walkLocal(pelvis.x, pelvis.z);
    [w.position.x, w.position.z] = walkWorld(
        THREE.MathUtils.clamp(across, -WALK_HALF_ACROSS, WALK_HALF_ACROSS),
        THREE.MathUtils.clamp(deep, -WALK_HALF_DEEP, WALK_HALF_DEEP),
    );
    w.position.y = GROUND_Y;
    const facing = Math.hypot(head.x - pelvis.x, head.z - pelvis.z);
    // Face-down or face-up, pelvis and head are nearly stacked and the direction
    // means nothing; keep the old heading rather than snapping to noise.
    if (facing > 0.05) w.heading = Math.atan2(head.x - pelvis.x, head.z - pelvis.z);
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

/**
 * Run to the front, then turn to face the camera and stand.
 *
 * Standing is not stopping: the gait has no phase where both knees are straight, so
 * a walker whose phase simply stops is caught mid-step. Fading `gait` to zero lands
 * on the rest stance instead, and the phase keeps ticking to drive the breath.
 */
function present(w: Walker, dt: number): void {
    const dx = SHOWCASE_SPOT[0] - w.position.x;
    const dz = SHOWCASE_SPOT[2] - w.position.z;
    const distance = Math.hypot(dx, dz);

    if (distance > SHOW_ARRIVED) {
        const speed = w.speed * SHOW_RUN;
        // Steer rather than snap, so the turn out of the crowd is a turn.
        const toward = Math.atan2(dx, dz);
        let delta = toward - w.heading;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        w.heading += THREE.MathUtils.clamp(delta, -SHOW_TURN_RATE * dt, SHOW_TURN_RATE * dt);
        // Never overshoot the spot on a long frame.
        const step = Math.min(speed * dt, distance);
        w.position.x += Math.sin(w.heading) * step;
        w.position.z += Math.cos(w.heading) * step;
        w.phase += ((Math.PI * speed) / strideLength(w.avatar.params)) * dt;
        w.gait = 1;
        return;
    }

    // Parked: turn to face the camera, and let the walk settle into a stand.
    let delta = SHOWCASE_FACING - w.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    w.heading += THREE.MathUtils.clamp(delta, -SHOW_TURN_RATE * dt, SHOW_TURN_RATE * dt);
    w.targetHeading = w.heading;
    w.gait = Math.max(0, w.gait - dt / SHOW_PARK_TIME);
    w.phase += SHOW_BREATH * dt;
}

/** How long to get back up to walking pace after a pause. */
const RESUME_TIME = 0.5;
/** How close, and how nearly in front, someone has to be for a walker to turn to them. */
const NOTICE_REACH = 3;
const NOTICE_CONE = 1.1;
/** How long a pause lasts. */
const LOOK_TIME: [number, number] = [1.8, 3.2];

/** Stop for a moment: turn to whoever's in front, if the mood takes them, or just look about. */
function startPause(crowd: Crowd, w: Walker): void {
    let nearest: Walker | null = null;
    let best = NOTICE_REACH;
    for (const other of crowd.walkers) {
        if (other === w || other.state === 'limp') continue;
        const dx = other.position.x - w.position.x;
        const dz = other.position.z - w.position.z;
        const dist = Math.hypot(dx, dz);
        let off = Math.atan2(dx, dz) - w.heading;
        off = Math.atan2(Math.sin(off), Math.cos(off));
        if (dist < best && Math.abs(off) < NOTICE_CONE) {
            best = dist;
            nearest = other;
        }
    }
    const turning = nearest !== null && Math.random() < w.face.personality.greetChance;
    w.pause = {
        t: 0,
        duration: between(LOOK_TIME),
        toward: turning && nearest ? Math.atan2(nearest.position.x - w.position.x, nearest.position.z - w.position.z) : null,
    };
}

/** Stand there: ease out of the walk, and turn to face them if that's the plan. */
function linger(w: Walker, pause: Pause, dt: number): void {
    pause.t += dt;
    // Same landing as the showcase: fade the gait, not the phase, so they settle
    // into a stance rather than freezing mid-stride. The phase drives the breath.
    w.gait = Math.max(0, w.gait - dt / SHOW_PARK_TIME);
    w.phase += SHOW_BREATH * dt;
    if (pause.toward !== null) {
        let delta = pause.toward - w.heading;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        w.heading += THREE.MathUtils.clamp(delta, -SHOW_TURN_RATE * dt, SHOW_TURN_RATE * dt);
    }
    w.targetHeading = w.heading;
    if (pause.t >= pause.duration) endPause(w);
}

function endPause(w: Walker): void {
    if (!w.pause) return;
    w.pause = null;
    w.pauseIn = between(w.face.personality.pauseEvery);
    // Somewhere new to head once they're off again.
    w.secondsUntilTurn = 0.3;
}

function steer(crowd: Crowd, w: Walker, dt: number): void {
    if (w.pause) {
        linger(w, w.pause, dt);
        return;
    }
    if (crowd.moving) {
        w.pauseIn -= dt;
        if (w.pauseIn <= 0) {
            startPause(crowd, w);
            if (w.pause) {
                linger(w, w.pause, dt);
                return;
            }
        }
    }
    // Back up to pace after a pause.
    w.gait = Math.min(1, w.gait + dt / RESUME_TIME);

    // Sum a push away from everyone inside your personal space, and steer toward
    // wherever that points. Steering the *target heading* rather than the position is
    // what keeps it looking like a decision; shoving positions apart looks magnetic.
    push.set(0, 0, 0);
    for (const other of crowd.walkers) {
        // Someone on the floor is something to trip over, not walk around.
        if (other === w || other.state === 'limp') continue;
        const dx = w.position.x - other.position.x;
        const dz = w.position.z - other.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > PERSONAL_SPACE || dist < 1e-4) continue;
        // Inverse falloff, so someone right in front dominates someone at the edge.
        const urgency = 1 - dist / PERSONAL_SPACE;
        push.x += (dx / dist) * urgency;
        push.z += (dz / dist) * urgency;
    }
    const crowding = Math.hypot(push.x, push.z);
    if (crowding > 1e-3) {
        const away = Math.atan2(push.x, push.z);
        let toward = away - w.targetHeading;
        toward = Math.atan2(Math.sin(toward), Math.cos(toward));
        // Harder the more crowded: a brush past is a nudge, a head-on is a swerve.
        w.targetHeading += toward * Math.min(1, crowding) * 0.6;
    }

    w.secondsUntilTurn -= dt;
    if (w.secondsUntilTurn <= 0) {
        w.targetHeading += (Math.random() - 0.5) * Math.PI * 1.1;
        w.secondsUntilTurn = TURN_EVERY[0] + Math.random() * (TURN_EVERY[1] - TURN_EVERY[0]);
    }

    // Turn back toward the middle at the edge; a hard reflection looks like a bug.
    const offX = w.position.x - WALK_CENTER[0];
    const offZ = w.position.z - WALK_CENTER[2];
    const [across, deep] = walkLocal(w.position.x, w.position.z);
    if (Math.abs(across) > WALK_HALF_ACROSS * 0.85 || Math.abs(deep) > WALK_HALF_DEEP * 0.85) {
        w.targetHeading = Math.atan2(-offX, -offZ);
    }

    if (crowd.moving) {
        // Turn toward the target by the shortest way round.
        let delta = w.targetHeading - w.heading;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        w.heading += THREE.MathUtils.clamp(delta, -TURN_RATE * dt, TURN_RATE * dt);

        // Scaled by the gait, so they don't glide while still finding their feet.
        w.position.x += Math.sin(w.heading) * w.speed * w.gait * dt;
        w.position.z += Math.cos(w.heading) * w.speed * w.gait * dt;
    }

    // One cycle is two steps, hence PI rather than 2PI.
    w.phase += ((Math.PI * w.speed) / strideLength(w.avatar.params)) * dt;
}
