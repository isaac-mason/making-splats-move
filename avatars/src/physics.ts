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
import { quat, vec3 } from 'mathcat';
import * as THREE from 'three';
import type { Avatar } from './avatar';
import type { Skeleton } from './bones';

/**
 * A rigid-body double for an avatar, via crashcat.
 *
 * Walking, the bodies are KINEMATIC and driven from the pose the splats are drawn
 * with. Knocked over, the same bodies go DYNAMIC and the pose flows the other way.
 *
 * That reversal is cheap because a pose is eleven world transforms
 * (`skeleton.worldQuat`/`worldPos`) and a rigid body IS a world transform. Forward
 * kinematics writes those arrays, `readPuppet` writes the same arrays from the
 * bodies, and `pushSkeleton` can't tell which did.
 */

/** Object layers, in the order `initPhysicsWorld` registers them. Asserted rather
 *  than assigned, so a second world can't rewrite them under the first. */
const LAYER_STATIC = 0;
const LAYER_BODY = 1;
/** Collides with nothing. The hand only ever acts through the grab constraint. */
export const LAYER_HAND = 2;

export type Puppet = {
    bodies: RigidBody[];
    joints: SwingTwistConstraint[];
    /** Each body's rest transform, in the MESH's local space — where the bones live. */
    restPos: THREE.Vector3[];
    restQuat: THREE.Quaternion[];
    /** True while the bodies are dynamic and owning the pose. */
    limp: boolean;
    /**
     * The mesh transform the bodies are read against: live while driven, frozen the
     * moment they go limp.
     *
     * Tempting to skip and pose the bones in world space, since the bodies are
     * already there — but a SplatMesh whose splats wander twelve metres from its own
     * transform is outside its own bounds and gets frustum-culled. It vanishes.
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

/** Fail loudly if crashcat ever stops handing back indices in registration order. */
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
        // Collides with every group, so no puppet can ever fall through it.
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
 * Build the bodies for one avatar, standing where it currently stands.
 *
 * `index` only picks a collision group, so a puppet's own capsules never collide
 * with each other — adjacent limbs overlap permanently at the joints and would fight
 * the constraint holding them together. Groups wrap at 30, so the 31st walker passes
 * through the 1st; nobody will see it at the sizes this runs at.
 */
export function initPuppet(world: World, avatar: Avatar, meshOrigin: THREE.Vector3, heading: number, index: number): Puppet {
    const bones = avatar.skeleton.bones;
    const bodies: RigidBody[] = [];
    const joints: SwingTwistConstraint[] = [];
    const restPos: THREE.Vector3[] = [];
    const restQuat: THREE.Quaternion[] = [];
    const yaw = new THREE.Quaternion().setFromAxisAngle(up, heading);
    // The bodies are built against the MESH's origin, not the walker's ground
    // position — the two differ by the sole lift, and getting that wrong spawns the
    // whole ragdoll hovering by exactly that much.
    const origin = meshOrigin.clone();
    const group = 1 << (index % 30);

    for (const bone of bones) {
        axis.copy(bone.tail).sub(bone.head);
        const length = Math.max(0.04, axis.length());
        axis.normalize();
        mid.copy(bone.head).addScaledVector(axis, length * 0.5);

        // +Y onto the bone, so a capsule built along Y lies along the limb. Recorded
        // in local space; only the copy handed to the body is lifted into the world.
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
                position: vec3.fromValues(worldPos.x, worldPos.y, worldPos.z),
                quaternion: quat.fromValues(worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w),
                collisionGroups: group,
                collisionMask: ~group,
                linearDamping: 0.05,
                angularDamping: 0.05,
                restitution: 0,
            }),
        );
    }

    // Joints at each bone's head, which is where it meets its parent. Built once and
    // never rebuilt: the constraint converts the world frame it's given into each
    // body's local frame, so it means the same joint however far the walker wanders.
    for (let i = 0; i < bones.length; i++) {
        const parent = bones[i].parent;
        if (parent < 0) continue;
        const joint = bones[i].head.clone().applyQuaternion(yaw).add(origin);
        const twist = new THREE.Vector3().copy(bones[i].tail).sub(bones[i].head).normalize().applyQuaternion(yaw);
        // Any direction perpendicular to the twist axis will do.
        const plane = new THREE.Vector3(twist.y, twist.z, twist.x).cross(twist).normalize();
        const pos = vec3.fromValues(joint.x, joint.y, joint.z);
        const tw = vec3.fromValues(twist.x, twist.y, twist.z);
        const pl = vec3.fromValues(plane.x, plane.y, plane.z);

        joints.push(
            swingTwistConstraint.create(world, {
                bodyIdA: bodies[parent].id,
                bodyIdB: bodies[i].id,
                // Both pivots are the same world point, which is what makes this a
                // joint rather than a spring.
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
            }),
        );
    }

    return { bodies, joints, restPos, restQuat, limp: false, origin, yaw, yawInv: yaw.clone().invert() };
}

/** For when an avatar is rebuilt and the old capsules no longer fit it. */
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
 * Drive the kinematic bodies to wherever the current pose puts them.
 *
 * `moveKinematic` reaches its target by setting a velocity rather than teleporting,
 * which is the whole reason a walking avatar can kick something.
 */
export function drivePuppet(puppet: Puppet, skeleton: Skeleton, dt: number): void {
    const { bodies, restPos, restQuat, origin, yaw } = puppet;
    for (let i = 0; i < bodies.length; i++) {
        // Bone transform, then mesh transform. A bone maps rest point p to
        // q(p - head) + pos, so that's where this body's centre lands.
        boneQuat.copy(skeleton.worldQuat[i]);
        offset.copy(restPos[i]).sub(skeleton.bones[i].head).applyQuaternion(boneQuat);
        bonePos.copy(skeleton.worldPos[i]).add(offset);

        worldPos.copy(bonePos).applyQuaternion(yaw).add(origin);
        worldQuat.copy(restQuat[i]).premultiply(boneQuat).premultiply(yaw);
        rigidBody.moveKinematic(
            bodies[i],
            vec3.fromValues(worldPos.x, worldPos.y, worldPos.z),
            quat.fromValues(worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w),
            Math.max(dt, 1 / 120),
        );
    }
}

/**
 * Hand the pose over to physics. The bodies keep whatever velocity `moveKinematic`
 * last gave them, so a walker knocked down mid-stride falls with the stride in it.
 */
export function goLimp(world: World, puppet: Puppet): void {
    if (puppet.limp) return;
    puppet.limp = true;
    for (const body of puppet.bodies) rigidBody.setMotionType(world, body, MotionType.DYNAMIC, true);
}

/** Take it back, so the rig drives the bodies again. */
export function goDriven(world: World, puppet: Puppet): void {
    if (!puppet.limp) return;
    puppet.limp = false;
    for (const body of puppet.bodies) rigidBody.setMotionType(world, body, MotionType.KINEMATIC, true);
}

const bodyQuat = new THREE.Quaternion();
const bodyPos = new THREE.Vector3();

/**
 * Read the bodies back into the pose arrays — forward kinematics, run backwards.
 *
 * Each body has turned by `R = current x rest⁻¹` since it was built, so a point at
 * `p` is now at `body.position + R x (p - bodyRest)`. In the mesh's local space
 * that's exactly the `(quat, pos)` pair the bone wants.
 */
export function readPuppet(puppet: Puppet, skeleton: Skeleton): void {
    const { bodies, restPos, restQuat, origin, yawInv } = puppet;
    for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        bodyQuat.set(body.quaternion[0], body.quaternion[1], body.quaternion[2], body.quaternion[3]);
        bodyQuat.premultiply(yawInv);
        bodyPos.set(body.position[0], body.position[1], body.position[2]).sub(origin).applyQuaternion(yawInv);

        skeleton.worldQuat[i].copy(restQuat[i]).invert().premultiply(bodyQuat);
        offset.copy(skeleton.bones[i].head).sub(restPos[i]).applyQuaternion(skeleton.worldQuat[i]);
        skeleton.worldPos[i].copy(bodyPos).add(offset);
    }
}

const rayCollector = createClosestCastRayCollector();
const raySettings = createDefaultCastRaySettings();
/** Keyed by world, so a filter built for one can't be handed to another. */
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

/** Ray against the puppets. See picking.ts for why not against the splats. */
export function pickBody(
    world: World,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    far: number,
    outPoint: THREE.Vector3,
): RigidBody | null {
    rayCollector.reset();
    castRay(
        world,
        rayCollector,
        raySettings,
        vec3.fromValues(origin.x, origin.y, origin.z),
        vec3.fromValues(direction.x, direction.y, direction.z),
        far,
        filterFor(world),
    );
    const { hit } = rayCollector;
    if (hit.status !== CastRayStatus.COLLIDING) return null;
    outPoint
        .copy(direction)
        .multiplyScalar(hit.fraction * far)
        .add(origin);
    return rigidBody.get(world, hit.bodyIdB) ?? null;
}

/** Which puppet, if any, owns this body. */
export function puppetOwns(puppet: Puppet, body: RigidBody): boolean {
    return puppet.bodies.includes(body);
}

/** How fast a body is moving — what "have they stopped tumbling?" asks. */
export function bodySpeed(body: RigidBody): number {
    const v = body.motionProperties.linearVelocity;
    return Math.hypot(v[0], v[1], v[2]);
}

/** A body's position in world space, into `out`. */
export function bodyPosition(out: THREE.Vector3, body: RigidBody): THREE.Vector3 {
    return out.set(body.position[0], body.position[1], body.position[2]);
}

export function stepPhysics(world: World, dt: number): void {
    // Clamped: a step that scales with a stalled frame is how ragdolls reach orbit.
    updateWorld(world, undefined, Math.min(dt, 1 / 30));
}
