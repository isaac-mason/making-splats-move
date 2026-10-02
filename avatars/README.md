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

The first test was a tube of splats, two bones, one joint, bent 85°. Nothing about it
was a character, on purpose: everything was chosen so a bug would be unmissable
rather than merely suspicious:

- **Uniform ring lattice**, so a hole or a pinch at the joint stands out.
- **Splats elongated along the limb.** Skinning has to transform each splat's
  *orientation*, not just its centre. If it didn't, these would stay pointing at the
  sky while the limb swings sideways and the horizontal section would read as a comb.
  It read as a smooth tube, so the orientations were being carried. With round splats
  you could never tell.
- **Banded colour**, so twist and stretch are readable.

The joint feathered cleanly, with no collapse — which is `DUAL_QUATERNION` doing its
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

That was checked by removing the correction and rendering again: the limb tore away
from the joint exactly as predicted — the cheapest way to know a diagnosis is real
rather than a plausible story. It all lives in `setBoneWorld`, in `bones.ts`.

## Then: a skeleton

Eleven bones, forward kinematics, and a walk cycle. The step up from the tube isn't
the bone count — it's that **the weights come from distance to a bone** rather than
from a hand-written rule about height.

That's the part that generalises. A real scan arrives as an undifferentiated cloud
with nothing in the file saying which splat is an arm; capsule distance is how you
decide. `weightsForPoint` scores every bone by Gaussian falloff on distance to its
segment, scaled by the bone's own radius so a thick thigh claims further than a thin
forearm, keeps the best four (Spark stores four per splat) and normalises. Nothing in
`bones.ts` or the weighting knows this figure is procedural — swap the geometry for a
loaded scan and it runs unchanged.

It's also cheap enough not to matter: the weighting is O(splats × bones) but runs
**once at load**, not per frame.

`setBoneWorld` generalised too: `poseSkeleton` walks the hierarchy accumulating
rotations, then `pushSkeleton` hands each bone its world transform through it.

## Then: ragdolls, almost for free

The default scene is six of them wandering a school courtyard, and with the **grab**
tool you can press on one, drop it, and carry it around by whatever limb you
grabbed. Let go and they fall; leave them a couple of seconds and they get back up.
Physics is [crashcat](https://www.npmjs.com/package/crashcat).

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
the courtyard. Going limp doesn't build anything — it flips the same bodies to dynamic
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

An avatar is about 51k splats; the cast of six is 325k, built in ~350 ms on an M1
Pro. **Cost tracks total splats, not avatar count**, because `updateBones()` dirties
every mesh every frame and Spark re-sorts the lot.

An earlier, denser build (159k splats an avatar) held vsync at four avatars and fell
to 25 ms a frame at sixteen — 2.5M splats, about where the re-sort starts to
dominate. `spacing` is the lever: cost goes as 1/spacing².

## The trap: a slow sort pulls them apart

Spark sorts asynchronously, with a GPU readback, so what's drawn is ordered by where
the splats were a frame or two ago. At rest nobody can tell. But a ragdoll limb
swinging fast, or a face swapping features, gets drawn against a stale order: skin
sorts over a feature for a frame and the face blinks out, or gaps open at the joints.

The fix was fewer splats, not a cleverer sort. At 1.3M splats for the cast the lag was
visible every time someone fell; at 325k it's gone. Expressions avoid it too: every
feature is built into the mesh up front, and changing face only switches parts off by
opacity, so no splat ever moves for it.

That's also why the trees sway at draw time (`tree-sway.ts`) rather than by
regenerating the capture: hundreds of thousands of scenery splats regenerating every
frame would slow every sort.

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

Six avatars walking a school courtyard, now and then stopping to look about or turn
to someone. Three tools on the bar at the bottom:

- **customize** — click a walker and they run out to the front, turn to face you and
  stand still while the camera drops to meet them; the sliders that built them open,
  grouped and named in plain language. Done (or Escape) sends them back and lifts the
  camera again. Reset gives that walker back rather than the stock character
- **grab** — press on a walker to drop them, drag to carry them, let go and they
  fall. Leave them a couple of seconds and they get back up
- **camera** — orbit. Its own tool on purpose: left always-on, every attempt to grab
  someone also swung the camera

Press backtick for the debug panel: freeze the crowd, show the walk bounds, toggle
skinning, movement, leaves and tree sway (and tint what the sway claims), and
click-to-copy camera coordinates.

The rest is URL switches, mostly for looking at one avatar on a plain stage:

- `?view=front|side|quarter|top|bust` shows one from that angle, and `?face` frames
  the head. **Use the side view**: front-on, a head buried in a chest and a clean
  join look identical
- `?editor` adds the full editor, `?seed=3` picks the third of the cast (1 is Mo)
- `?expression=happy|blink|scared|dizzy` and `?gaze=0.8,-0.2` hold a face. In the
  courtyard the face follows the walker: scared while held, dizzy on the floor
- `?t=0.62` freezes the walk at a moment. A moving rig is a terrible thing to test
  against: you can't tell whether a still frame caught a bug or the bottom of a swing
- `?crowd=16` builds a grid of them, for measuring cost; `?stats` prints frame time
- `?cam=x,y,z&look=x,y,z` places the camera, `?bare` drops the capture, and
  `?bg=ff00ff` tells a gap in the splats from a dark splat

## How it's laid out

Two scenes share the avatar and nothing else:

- **`courtyard.ts`** — the default. `crowd.ts` is everything the avatars DO: walking,
  pausing, falling and getting up, where they look, how they blink, and their
  personalities. `physics.ts` is the rigid-body double; `interaction.ts` is
  everything the pointer does — the toolbar, picking, grabbing and the customise
  camera. `tree-sway.ts` sways the trees and `leaves.ts` drops leaves off them.
- **`workbench.ts`** — one avatar on a plain stage, behind the URL switches above.

Under both: `avatar.ts` builds a character out of splats and rigs it with `bones.ts`;
`avatar-params.ts` holds every field, style and colour that shapes one, and the cast;
`avatar-editor.ts` is the panel that drives them; `scene.ts` holds everything
specific to this capture, so swapping in another world is a one-file edit.

`index.ts` reads `options.ts`, builds a renderer, picks a scene, and runs the loop.

## Assets

The school courtyard is a Gaussian-splat capture (`project-cartoon-school-campus-courtyard.spz`).

- `assets/school-courtyard.spz` — the source splat. Not served: only the LOD file is.
- `public/school-courtyard-lod.rad` — the LOD-paged build, what the browser loads.

Rebuild the `.rad` with `pnpm build:lod` (needs a Rust toolchain; see
[`dust/README.md`](../dust/README.md#assets) for how the script and the paging work).
