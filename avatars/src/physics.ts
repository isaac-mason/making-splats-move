/**
 * A rigid-body double for an avatar, via crashcat: one capsule per bone.
 *
 * Walking, the bodies are KINEMATIC and follow the pose. Knocked over, the same
 * bodies go DYNAMIC and the pose flows the other way. That's cheap because a pose is
 * just a world transform per bone, and so is a rigid body: forward kinematics and
 * `readPuppet` write the same arrays, and `pushSkeleton` can't tell which did.
 */

import {
    addBroadphaseLayer,
    addObjectLayer,
    box,
    CastRayStatus,
    ConstraintSpace,
    capsule,
    castRay,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
    createWorld,
    createWorldSettings,
    enableCollision,
    filter as layerFilter,
    MotionType,
    type RigidBody,
    registerAllConstraints,
    registerAllShapes,
    rigidBody,
    type SwingTwistConstraint,
    swingTwistConstraint,
    updateWorld,
    type World,
} from 'crashcat';
import { type Quat, quat, type Vec3, vec3 } from 'math';
import * as THREE from 'three';
import type { Avatar } from './avatar';
import type { Skeleton } from './bones';

/** Object layers, in the order `initPhysicsWorld` registers them (and asserts). */
const LAYER_STATIC = 0;
const LAYER_BODY = 1;
/** Collides with nothing. The hand only ever acts through the grab constraint. */
export const LAYER_HAND = 2;

export type Puppet = {
    bodies: RigidBody[];
    joints: SwingTwistConstraint[];
    /** Each body's rest transform, in the mesh's local space, where the bones live. */
    restPos: THREE.Vector3[];
    restQuat: THREE.Quaternion[];
    limp: boolean;
    /**
     * The mesh transform the bodies are read against: live while driven, frozen the
     * moment they go limp. Not just world space: an avatar whose splats wander far
     * from its own transform falls outside its bounds and gets frustum-culled.
     */
    origin: THREE.Vector3;
    yaw: THREE.Quaternion;
    yawInv: THREE.Quaternion;
};

export function initPhysicsWorld(): World {
    registerAllShapes();
    registerAllConstraints();
    const settings = createWorldSettings();
    const broadphase = addBroadphaseLayer(settings);
    expectLayer(addObjectLayer(settings, broadphase), LAYER_STATIC);
    expectLayer(addObjectLayer(settings, broadphase), LAYER_BODY);
    expectLayer(addObjectLayer(settings, broadphase), LAYER_HAND);
    enableCollision(settings, LAYER_BODY, LAYER_STATIC);
    enableCollision(settings, LAYER_BODY, LAYER_BODY);
    return createWorld(settings);
}

function expectLayer(got: number, want: number): void {
    if (got !== want) throw new Error(`physics: expected object layer ${want}, got ${got}`);
}

/** A big static slab for them to land on. */
export function addGroundPlane(world: World, y: number): void {
    rigidBody.create(world, {
        shape: box.create({ halfExtents: vec3.fromValues(60, 0.5, 60), convexRadius: 0.05 }),
        objectLayer: LAYER_STATIC,
        motionType: MotionType.STATIC,
        position: vec3.fromValues(0, y - 0.5, 0),
        collisionGroups: 0xffffffff,
        collisionMask: 0xffffffff,
    });
}

const axis = new THREE.Vector3();
const mid = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const alignQuat = new THREE.Quaternion();
const worldQuat = new THREE.Quaternion();
const worldPos = new THREE.Vector3();

/**
 * Build the bodies for one avatar where it stands. `meshOrigin` is the mesh's
 * position, not the walker's ground point: they differ by the sole lift.
 *
 * `index` picks a collision group, so a puppet's own capsules (which overlap at every
 * joint) don't collide with each other. Groups wrap at 30.
 */
export function initPuppet(world: World, avatar: Avatar, meshOrigin: THREE.Vector3, heading: number, index: number): Puppet {
    const bones = avatar.skeleton.bones;
    const bodies: RigidBody[] = [];
    const joints: SwingTwistConstraint[] = [];
    const restPos: THREE.Vector3[] = [];
    const restQuat: THREE.Quaternion[] = [];
    const yaw = new THREE.Quaternion().setFromAxisAngle(up, heading);
    const origin = meshOrigin.clone();
    const group = 1 << (index % 30);

    for (const bone of bones) {
        axis.copy(bone.tail).sub(bone.head);
        const length = Math.max(0.04, axis.length());
        axis.normalize();
        mid.copy(bone.head).addScaledVector(axis, length * 0.5);

        // +Y onto the bone, so a capsule built along Y lies along the limb.
        alignQuat.setFromUnitVectors(up, axis);
        restPos.push(mid.clone());
        restQuat.push(alignQuat.clone());
        worldQuat.copy(alignQuat).premultiply(yaw);
        worldPos.copy(mid).applyQuaternion(yaw).add(origin);

        bodies.push(
            rigidBody.create(world, {
                // Capsules, not boxes: rounded ends stop neighbours catching corners.
                shape: capsule.create({
                    halfHeightOfCylinder: Math.max(0.01, length * 0.5 - bone.radius),
                    radius: bone.radius,
                    density: 1000,
                }),
                objectLayer: LAYER_BODY,
                motionType: MotionType.KINEMATIC,
                position: toVec3(vec3.create(), worldPos),
                quaternion: toQuat(quat.create(), worldQuat),
                collisionGroups: group,
                collisionMask: ~group,
                linearDamping: 0.05,
                angularDamping: 0.05,
                restitution: 0,
            }),
        );
    }

    // A joint at each bone's head, where it meets its parent. Given in world space but
    // stored per body, so it holds however far the walker wanders.
    for (let i = 0; i < bones.length; i++) {
        const parent = bones[i].parent;
        if (parent < 0) continue;
        const joint = bones[i].head.clone().applyQuaternion(yaw).add(origin);
        const twist = new THREE.Vector3().copy(bones[i].tail).sub(bones[i].head).normalize().applyQuaternion(yaw);
        // Any direction perpendicular to the twist axis will do.
        const plane = new THREE.Vector3(twist.y, twist.z, twist.x).cross(twist).normalize();
        const pos = toVec3(vec3.create(), joint);
        const tw = toVec3(vec3.create(), twist);
        const pl = toVec3(vec3.create(), plane);

        joints.push(
            swingTwistConstraint.create(world, {
                bodyIdA: bodies[parent].id,
                bodyIdB: bodies[i].id,
                position1: pos,
                position2: vec3.clone(pos),
                twistAxis1: tw,
                planeAxis1: pl,
                twistAxis2: vec3.clone(tw),
                planeAxis2: vec3.clone(pl),
                space: ConstraintSpace.WORLD,
                normalHalfConeAngle: Math.PI / 4,
                planeHalfConeAngle: Math.PI / 4,
                twistMinAngle: -Math.PI / 8,
                twistMaxAngle: Math.PI / 8,
                // Well above the defaults (10 and 2): a grab pulls hard enough on one
                // limb to overrun every joint limit behind it.
                numVelocityStepsOverride: 20,
                numPositionStepsOverride: 8,
            }),
        );
    }

    return { bodies, joints, restPos, restQuat, limp: false, origin, yaw, yawInv: yaw.clone().invert() };
}

/** When an avatar is rebuilt and the old capsules no longer fit. */
export function disposePuppet(world: World, puppet: Puppet): void {
    for (const joint of puppet.joints) swingTwistConstraint.remove(world, joint);
    for (const body of puppet.bodies) rigidBody.remove(world, body);
    puppet.joints.length = 0;
    puppet.bodies.length = 0;
}

/** Where the mesh is, so the bodies and the bones agree on a space. */
export function setPuppetFrame(puppet: Puppet, origin: THREE.Vector3, heading: number): void {
    puppet.origin.copy(origin);
    puppet.yaw.setFromAxisAngle(up, heading);
    puppet.yawInv.copy(puppet.yaw).invert();
}

const boneQuat = new THREE.Quaternion();
const bonePos = new THREE.Vector3();
const offset = new THREE.Vector3();

/**
 * Drive the kinematic bodies to the current pose. `moveKinematic` gets there by
 * velocity rather than teleporting, which is what lets a walker kick someone.
 */
export function drivePuppet(puppet: Puppet, skeleton: Skeleton, dt: number): void {
    const { bodies, restPos, restQuat, origin, yaw } = puppet;
    for (let i = 0; i < bodies.length; i++) {
        // A bone maps rest point p to q(p - head) + pos; then the mesh transform.
        boneQuat.copy(skeleton.worldQuat[i]);
        offset.copy(restPos[i]).sub(skeleton.bones[i].head).applyQuaternion(boneQuat);
        bonePos.copy(skeleton.worldPos[i]).add(offset);

        worldPos.copy(bonePos).applyQuaternion(yaw).add(origin);
        worldQuat.copy(restQuat[i]).premultiply(boneQuat).premultiply(yaw);
        rigidBody.moveKinematic(bodies[i], toVec3(_position, worldPos), toQuat(_rotation, worldQuat), Math.max(dt, 1 / 120));
    }
}

/** Hand the pose to physics. Bodies keep their velocity, so a stride carries into the fall. */
export function goLimp(world: World, puppet: Puppet): void {
    if (puppet.limp) return;
    puppet.limp = true;
    for (const body of puppet.bodies) rigidBody.setMotionType(world, body, MotionType.DYNAMIC, true);
}

export function goDriven(world: World, puppet: Puppet): void {
    if (!puppet.limp) return;
    puppet.limp = false;
    for (const body of puppet.bodies) rigidBody.setMotionType(world, body, MotionType.KINEMATIC, true);
}

const bodyQuat = new THREE.Quaternion();
const bodyPos = new THREE.Vector3();

/**
 * Read the bodies back into the pose arrays, in the mesh's local space — forward
 * kinematics run backwards. Each bone's rotation is its body's, less the body's rest.
 */
export function readPuppet(puppet: Puppet, skeleton: Skeleton): void {
    const { bodies, restPos, restQuat, origin, yawInv } = puppet;
    for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        bodyQuat.set(body.quaternion[0], body.quaternion[1], body.quaternion[2], body.quaternion[3]);
        bodyQuat.premultiply(yawInv);
        bodyPosition(bodyPos, body).sub(origin).applyQuaternion(yawInv);

        skeleton.worldQuat[i].copy(restQuat[i]).invert().premultiply(bodyQuat);
        const parent = skeleton.bones[i].parent;
        if (parent < 0) {
            offset.copy(skeleton.bones[i].head).sub(restPos[i]).applyQuaternion(skeleton.worldQuat[i]);
            skeleton.worldPos[i].copy(bodyPos).add(offset);
        } else {
            // Children take only their ROTATION from the bodies and hang off the
            // parent's joint. The constraints are soft: a grab drags bodies cm apart,
            // and skin stretched across that gap thins until you see through it.
            // Chained, the drawn body can't come apart. (Parents come first.)
            offset.copy(skeleton.bones[i].head).sub(skeleton.bones[parent].head).applyQuaternion(skeleton.worldQuat[parent]);
            skeleton.worldPos[i].copy(skeleton.worldPos[parent]).add(offset);
        }
    }
}

const rayCollector = createClosestCastRayCollector();
const raySettings = createDefaultCastRaySettings();
const rayFilters = new WeakMap<World, ReturnType<typeof layerFilter.forWorld>>();

function filterFor(world: World): ReturnType<typeof layerFilter.forWorld> {
    const existing = rayFilters.get(world);
    if (existing) return existing;
    const filter = layerFilter.forWorld(world);
    // Only the puppets: the ground would swallow every click that missed it.
    filter.bodyFilter = (body) => body.objectLayer === LAYER_BODY;
    rayFilters.set(world, filter);
    return filter;
}

/** Ray against the puppets — see interaction.ts for why not against the splats. */
export function pickBody(
    world: World,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    far: number,
    outPoint: THREE.Vector3,
): RigidBody | null {
    rayCollector.reset();
    castRay(world, rayCollector, raySettings, toVec3(_position, origin), toVec3(_direction, direction), far, filterFor(world));
    const { hit } = rayCollector;
    if (hit.status !== CastRayStatus.COLLIDING) return null;
    outPoint
        .copy(direction)
        .multiplyScalar(hit.fraction * far)
        .add(origin);
    return rigidBody.get(world, hit.bodyIdB) ?? null;
}

export function puppetOwns(puppet: Puppet, body: RigidBody): boolean {
    return puppet.bodies.includes(body);
}

/** Have they stopped tumbling? */
export function bodySpeed(body: RigidBody): number {
    const v = body.motionProperties.linearVelocity;
    return Math.hypot(v[0], v[1], v[2]);
}

export function bodyPosition(out: THREE.Vector3, body: RigidBody): THREE.Vector3 {
    return out.set(body.position[0], body.position[1], body.position[2]);
}

export function stepPhysics(world: World, dt: number): void {
    // Clamped: a step the size of a stalled frame is how ragdolls reach orbit.
    updateWorld(world, undefined, Math.min(dt, 1 / 30));
}

/* three.js ↔ crashcat, which speaks `math` vectors */

function toVec3(out: Vec3, v: THREE.Vector3): Vec3 {
    return vec3.set(out, v.x, v.y, v.z);
}

function toQuat(out: Quat, q: THREE.Quaternion): Quat {
    return quat.set(out, q.x, q.y, q.z, q.w);
}

// Per-frame conversions land here; crashcat copies what it's handed.
const _position = vec3.create();
const _direction = vec3.create();
const _rotation = quat.create();
