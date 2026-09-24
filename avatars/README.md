# avatars

Procedural rigged characters built out of Gaussian splats, skinned with Spark and
walking. No scan, no mesh, no asset — the geometry and the skeleton are generated
from the same numbers, so every joint is in the right place by construction.

It started as a spike answering one question: **does Spark's `SplatSkinning`
actually work?**

Worth asking, because nothing suggested it did. There is no working demonstration
of it anywhere — not in Spark's repo, not in its docs, not in its
[examples gallery](https://sparkjs.dev/examples/), and not outside it. Every
runnable rigged-splat demo I could find ([Gaussian-VRM](https://github.com/naruya/gaussian-vrm),
[brush_avatar](https://github.com/felixtaubner/brush_avatar),
[SplattingAvatar](https://github.com/initialneil/SplattingAvatar)) uses a different
renderer. It's marked experimental in its own header. And the one real usage in
Spark's repo, `examples/portal`, is written against a bone-weight API
(`computeBoneWeights`, `boneSplats`) that appears in that example file and **nowhere
else** — not in `src/`, not in `dist/`, and not in the published package at either
2.1.0 or 2.2.0.

## The answer: yes

A tube of splats, two bones, one joint, bent 85° (`?limb`):

Nothing here is a character on purpose. Everything is chosen so a bug is unmissable
rather than merely suspicious:

- **Uniform ring lattice**, so a hole or a pinch at the joint stands out.
- **Splats elongated along the limb.** Skinning has to transform each splat's
  *orientation*, not just its centre. If it didn't, these would stay pointing at the
  sky while the limb swings sideways and the horizontal section would read as a comb.
  It reads as a smooth tube, so the orientations are being carried. With round splats
  you could never tell.
- **Banded colour**, so twist and stretch are readable.

The joint feathers cleanly, with no collapse — which is `DUAL_QUATERNION` doing its
job. Spark's linear-blend path refuses to run on a plain `Gsplat` at all (it throws,
demanding `covSplats`), because linear-blending an anisotropic Gaussian is only
meaningful on the full covariance. That matches the literature exactly:
[*On the Skinning of Gaussian Avatars*](https://arxiv.org/abs/2509.11411) finds that
linear blend skinning "does not provide valid results for [Gaussians'] non-linear
rotation properties", and lands on quaternion averaging as the fix.

## The trap: bones don't rotate about themselves

This one cost the most time and is invisible from the API. `setBoneQuatPos(i, quat,
pos)` looks like "put bone `i` at `pos`, rotated by `quat`". It isn't.

Spark stores the bone as a dual quaternion `(R, t)` with

```
R = restQuat⁻¹ · quat
t = pos − restPos
```

and the shader applies it as `v → R·v + t`. So **R rotates about the world origin**,
and `t` is a plain translation delta — this is not the usual
`current · rest⁻¹` skinning matrix. Hand it the joint as `pos` and the limb doesn't
hinge, it tears off and orbits.

Rotating about a pivot `p` needs `t = p − R·p`, so the `pos` to pass is
`p + (p − R·p)`:

```ts
const rotated = pivot.clone().applyQuaternion(quat);
const pos = pivot.clone().add(pivot.clone().sub(rotated));
skinning.setBoneQuatPos(bone, quat, pos);
```

That explanation was checked by removing the correction and rendering again — the
limb tears away from the joint exactly as predicted. Worth doing: it's the cheapest
way to be sure a diagnosis is the real one rather than a plausible story that
happened to coincide with a working result.

## Then: a stick figure

Eleven bones, forward kinematics, and a walk cycle. The step up from the tube isn't
the bone count — it's that **the weights now come from distance to a bone** rather
than from a hand-written rule about height.

That's the part that generalises. A real scan arrives as an undifferentiated cloud
with nothing in the file saying which splat is an arm; capsule distance is how you
decide. `weightsForPoint` scores every bone by Gaussian falloff on distance to its
segment, scaled by the bone's own radius so a thick thigh claims further than a thin
forearm, keeps the best four (Spark stores four per splat) and normalises. Nothing in
`bones.ts` or the weighting knows this figure is procedural — swap the geometry for a
loaded scan and it runs unchanged.

It's also cheap enough not to matter: the weighting is O(splats × bones) but runs
**once at load**, not per frame. A few hundred milliseconds at scan scale.

The `setBoneWorld` helper from the tube generalised too, and now every bone goes
through it — `apply()` walks the hierarchy accumulating rotations, then hands each
bone its world transform.

## Then: ragdolls, almost for free

The default scene is five of them wandering a town square, and with the debug panel
open (backtick) and **drag to ragdoll** ticked, you can press on one, drop it, and
carry it around by whatever limb you grabbed. Let go and they fall. Leave them a
couple of seconds and they get back up. Physics is
[crashcat](https://www.npmjs.com/package/crashcat).

The join is small, and it's small because of a decision made much earlier. A pose
here is eleven **world** transforms — `skeleton.worldQuat`/`worldPos`, which
`pushSkeleton` hands to Spark. A rigid body *is* a world transform. So ragdolling
isn't a skinning feature at all; it's "write those arrays from the bodies instead of
from forward kinematics", and nothing downstream knows the difference:

```ts
skeleton.worldQuat[i].copy(restQuat[i]).invert().premultiply(bodyQuat);
offset.copy(skeleton.bones[i].head).sub(restPos[i]).applyQuaternion(skeleton.worldQuat[i]);
skeleton.worldPos[i].copy(bodyPos).add(offset);
```

One capsule per bone, sized from the avatar's own proportions, jointed to its parent
with a swing-twist constraint at the shared joint. The skeleton already has exactly
the topology a ragdoll wants — a pelvis root, a spine, four two-link limb chains — so
there's no retargeting step.

## Walkers are physical too

Every walker carries those bodies the whole time, not just once it's been knocked
over. On its feet they're **kinematic** and get driven from the same pose the splats
are drawn with, so an upright avatar can trip over a fallen one and boot it across
the square. Going limp doesn't build anything — it flips the same bodies to dynamic
and reverses which end of the pipe is the source.

The detail that makes the kicking work is that `moveKinematic` reaches its target by
setting a **velocity** rather than teleporting. A body that jumps to a new position
has no momentum to hand over; a body that moves has plenty. Getting the same shove
out of a teleported limb would mean applying impulses by hand.

Two knock-on decisions:

- Each puppet gets its own collision group, so its capsules never collide with each
  other. Adjacent limbs permanently overlap at the joints, and left to themselves
  they'd fight the constraint holding them together.
- The crowd's avoidance steering skips anyone lying down. Someone on the floor isn't
  an obstacle to walk around, they're something to trip over — and if the steering
  kept avoiding them, none of the above would ever get a chance to happen.

## Getting back up

After a couple of seconds still, a fallen walker stands up where it landed and
blends out of the sprawl over about a second. The blend itself is one `slerp` and
one `lerp` per bone, because the ragdoll pose and the walk pose are the same eleven
transforms in the same arrays.

The whole trick is **ordering**. Move the mesh frame to where they're going to stand
*first*, then read the bodies against that new frame — the sprawl comes out already
expressed in the space the walk pose lives in, and the two can just be mixed. Read
them against the old frame and you're left blending two poses in different spaces,
which is a rotation short of meaningless.

The gait keeps running underneath, so at the end of the blend there's nothing to
pop: they're already exactly in the stride they're about to continue with.

The one trap in all of this: it's tempting to park the mesh at the origin and pose
the bones in world space, since the bodies are already there. Do that and the avatar
**vanishes**. A `SplatMesh` whose splats have wandered twelve metres from its own
transform is outside its own bounds and gets frustum-culled.

Picking one up is a kinematic "hand" body following the pointer through a
camera-facing plane, tied to the nearest limb by a distance constraint pinned at
zero. That's a grip, not a weld — the body still swings and spins under it, which is
the difference between carrying a person and steering a statue.

## The trap: you can't raycast a skinned splat

Picking a walker with the pointer looks like a solved problem — `SplatMesh`
implements `raycast`, so three's raycaster works on it. It's a quiet bug.

Spark raycasts the **packed splat array**, which is the rest pose. Skinning happens
in the shader, so as far as that raycast is concerned every avatar is permanently
standing to attention at its mesh origin. An arm swung forward isn't where it says
it is, and someone lying on the ground isn't there at all — you'd be clicking at the
spot where they'd be standing. Which is exactly how it behaved: picking worked
*sometimes*, and never on anyone you'd just knocked over.

The fix falls out of the physics being there already. The capsules are moved to
match the drawn pose every frame, so they're the only thing in the scene that knows
where a walker actually is — `pickWalker` casts a ray at those instead, through
crashcat, and maps the body it hits back to its walker.

## What it costs

Measured on an M1 Pro, every avatar animating every frame:

| avatars | splats | build (one-off) | steady state |
| --- | --- | --- | --- |
| 1 | 159k | 266 ms | 8.3 ms — vsync-capped |
| 4 | 635k | 850 ms | 8.3 ms — vsync-capped |
| 16 | 2.5M | 2.9 s | 25 ms |

One avatar is free; the wall is around a million splats, which is where the
per-frame re-sort starts to dominate. Note the shape of that: **cost tracks total
splats, not avatar count**, because `updateBones()` dirties every mesh every frame
and Spark re-sorts the lot.

Two levers if you wanted a real crowd. `spacing` is the big one, since cost goes as
1/spacing² — it's at 0.008 for close-up sharpness, and back at 0.0125 an avatar is
~66k splats, so you'd fit 2.4x as many for the same budget. Distant ones don't need
the detail. And only animate what's moving: a still avatar needn't call
`updateBones()`, so it never dirties and never forces a re-sort, which is likely a
bigger win than the splat count.

## What still isn't solved

**Weights on a real scan.** Capsule distance works here because the skeleton was
authored to match geometry that was itself generated from that skeleton — the bones
are in exactly the right places by construction. On a scan you have to *place* them
first, against a cloud with no landmarks, and distance falloff alone will happily
bind a splat of the left sleeve to the right arm where they touch. That placement
step is the real project, and it's the part upstream appears to be building
(`computeBoneWeights`), so it may not be worth duplicating.

**The cost.** `updateBones()` sets `mesh.needsUpdate`, so the mesh regenerates, the
splats move, Spark re-sorts, and sorting means a GPU readback — every animated frame
pays it. That's the cost [`wind/`](../wind) measured, and it already has the rig for
measuring it.

**Is it dodgeable?** Possibly. At the exact point [`wind/`](../wind) patches Spark's
draw-time vertex shader, `splatIndex`, `center` **and** `quaternion` are all in scope
as mutable locals — so the same dual-quaternion transform could be applied at draw
time, where the splat buffer never goes dirty and none of the re-sort fires. As far
as I can tell nobody has shown that. It's the reason this is worth continuing.

## Running it

```bash
pnpm --filter avatars dev
```

Shows five avatars walking a town square. Three tools on the bar at the bottom:

- **customize** — click a walker and they run out to the front, turn to face you and
  stand still while the camera drops to meet them; the sliders that built them open,
  grouped and named in plain language. Done (or Escape) sends them back and lifts the
  camera again. Reset gives that walker back rather than the stock character
- **grab** — press on a walker to drop them, drag to carry them, let go and they
  fall. Leave them a couple of seconds and they get back up
- **camera** — orbit. Its own tool on purpose: left always-on, every attempt to grab
  someone also swung the camera

Press backtick for the debug panel on top of that — freeze the crowd, show the walk
bounds, click-to-copy camera coordinates. `?figure` gives the plain stick figure
and `?limb` the one-joint diagnostic tube — both kept because they fail more legibly
than a finished character does.

- `?t=0.62` / `?bend=85` freeze the pose at a fixed moment or angle
- `?view=front|side|quarter|top|bust` shows one avatar from that angle. **Use the side
  view.** Judging a solid head-on is how a head ends up buried inside a chest:
  front-on, an intersection and a clean join look identical
- `?seed=3` rolls different proportions and colours; seed 1 is the authored look
- `?expression=happy|blink|scared|dizzy` holds one face. In the square the face
  follows the walker: scared while held, dizzy on the floor, blinking otherwise
- `?crowd=16` builds a grid of them, for measuring what one actually costs
- `?stats` prints frame time to the console (implied by `?crowd`)

Freezing matters more than it sounds: a moving rig is a terrible thing to test
against, because you can never tell whether a still frame caught a bug or just caught
the bottom of the swing.

## How it's laid out

Two worlds that share the avatar and nothing else, which is the main thing to know
before reading any of it:

- **`town-square.ts`** — the finished one. The crowd, the physics world, and the two
  tools you can point at them. `crowd.ts` walks them and decides when they fall and
  get up; `physics.ts` is the rigid-body double; `grab.ts`, `picking.ts`,
  `showcase.ts` and `toolbar.ts` are the interaction.
- **`workbench.ts`** — where it came from. One rig on a plain stage, behind `?limb`,
  `?figure`, `?editor` and `?crowd=N`.

Under both: `avatar.ts` builds a character out of `shell.ts` primitives and rigs it
with `bones.ts`; `avatar-params.ts` holds every number that shapes one and
`avatar-editor.ts` the panel that drives them; `scene.ts` holds everything specific
to THIS capture, so swapping in another world is a one-file edit.

`index.ts` does none of that. It reads `options.ts`, builds a renderer, frames a
camera, picks one of the two worlds, and runs a loop.
