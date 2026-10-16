# dust

Dust drifting through a sunlit Gaussian-splat greenhouse. An exercise in
atmosphere: the room is a static splat scene, and everything that makes it feel
like a place with air in it is generated at runtime.

> **Ported to [spark-radix][radix].** This was first written on Spark, and parts
> of the reasoning below quote Spark's docs. The design carries over unchanged:
> the mote kernel is now a TSL `generateSplat(index)` generator, the greenhouse
> and the dust share one `SplatCollection` and so one sort, and the `THREE.Points`
> counter-example is an instanced quad on three's `PointsNodeMaterial`. Radix sorts
> on the GPU, so the readback stall described for Spark doesn't apply.

## Motes as splats

The motes are real Gaussian splats, not a `THREE.Points` cloud, and that's the
whole point — they sort and blend with the environment splats, so a mote behind a
leaf is properly hidden instead of drawn over it. Getting that from `Points` would
mean depth-sorting them against the splat scene yourself, every frame.

To see the difference, open the debug panel (backtick) and tick **THREE.Points dust**.
That turns on [`src/dust-points.ts`](src/dust-points.ts): the same motion ported
to a `Points` shader. Spark draws splats with `depthWrite: false`, so there's no
greenhouse in the depth buffer for the points to test against, and every mote
draws over the leaves and frames in front of it. The points field reaches past the
walls on purpose: splat motes out there would be hidden by the room, so points
showing through it make the failure obvious, especially once you orbit.

## Nothing is stored

A [`SplatGenerator`](src/dust.ts) is handed a splat index and must return that
splat. So every mote's position, size, colour and brightness is **recomputed from
its index** each frame: hash the index for a stable random seed, then evaluate a
closed-form function of (seed, time). No particle buffer, no spawn/despawn
bookkeeping, no CPU work proportional to the mote count — going from 1 mote to
100,000 costs nothing on the CPU.

The recycling trick is the neat part. Rather than tracking motes leaving the volume
and respawning them, the whole field is offset by a drift that advances each frame
and the position is taken `fract()` of, so the field wraps through itself forever.
A mote drifting out of the top reappears at the bottom automatically, because it
never really left — only the sample point moved.

Spark's docs call this out as the intended pattern for particle effects, and ship
`generators.snowBox` built on it. **If you want snow or rain, use theirs.** This
example writes its own because dust behaves differently: it hangs rather than
falls, and the interesting parameters are turbulence and glint rather than fall
velocity.

Spark's docs also note a constraint this design has to respect: splat sorting can
lag a frame behind, so there must be a *stable correspondence* between one frame's
splat and the next for the same index. Here that holds by construction — the hash
is fixed forever and drift, swirl and bob are all continuous, so an index traces a
smooth path. The one discontinuity is the `fract()` wrap, which is why a mote
shouldn't be re-randomised as it recycles, however tempting that is as a way to add
variety.

## Making dust look like dust

- **It hangs.** The drift is a barely-there sideways creep with a slight settle,
  not a fall.
- **It turns over.** Three sines at different rates, each fed by a different axis
  of the mote's own position, so neighbours move together in slow eddies instead
  of each jittering independently.
- **Sizes are cubed** toward the small end. A few big flecks among many fine ones
  reads as dust; a uniform haze of identical specks reads as noise.
- **It glints slowly.** A mote flashes as it tumbles through the light, but that's
  a drift over *seconds* — `twinkleSpeed` is a fraction of a hertz. Above ~0.2 it
  stops reading as dust and starts reading as flicker.
- **Motes near the lens fade out.** A mote a few centimetres from the camera is
  geometrically correct and looks like a thumbprint on the screen, so `nearFade`
  removes them. Without it the handful of closest motes project to enormous soft
  blobs across the frame.

## The camera

While the mouse is hovering, the camera leans gently toward the cursor — enough to
make the room feel like somewhere you're standing rather than a photograph.

Mouse only. On a touch screen there's no hover, so phones get the plain orbit
camera and no touch listeners at all.

The fiddly bit is co-existing with `OrbitControls`, which derives its spherical
state *from* `camera.position` every update — so an offset added on top gets
absorbed into that state and compounds into a slow unwanted drift. `apply()` backs
the previous offset out, lets OrbitControls run on a clean position, then adds the
new one, so OrbitControls only ever sees the camera where it put it.

## Layout

| File | Role |
| --- | --- |
| `src/dust.ts` | The generator: the mote kernel and every tunable. |
| `src/dust-points.ts` | The same dust as a `THREE.Points` cloud — the counter-example. |
| `src/camera-drift.ts` | The cursor lean. |
| `src/scene.ts` | Asset URL, camera framing, and the volume the dust fills. |
| `src/splat.ts` | Loads the greenhouse on a worker and places it as one splat object. |
| `src/performance.ts` | Render scale, the one quality knob. |

## Assets

The greenhouse came from [Marble](https://marble.worldlabs.ai/) (World Labs'
3D-world generator).

`assets/greenhouse.spz` (7 MB) is what the browser loads, flat: radix draws every
splat every frame and has no level-of-detail paging yet.

[radix]: https://github.com/asundqui/radix-test
