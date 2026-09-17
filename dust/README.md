# dust

Dust drifting through a sunlit Gaussian-splat greenhouse. An exercise in
atmosphere: the room is a static splat scene, and everything that makes it feel
like a place with air in it is generated at runtime.

## Motes as splats

The motes are real Gaussian splats, not a `THREE.Points` cloud, and that's the
whole point — they sort and blend with the environment splats, so a mote behind a
leaf is properly hidden instead of drawn over it. Getting that from `Points` would
mean depth-sorting them against the splat scene yourself, every frame.

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
| `src/camera-drift.ts` | The cursor lean. |
| `src/scene.ts` | Asset URL, camera framing, and the volume the dust fills. |
| `src/splat.ts` | SparkRenderer + SplatMesh setup. |
| `src/performance.ts` | LOD + quality budget, tuned per platform. |

## Assets

`public/greenhouse.spz` came from [Marble](https://marble.worldlabs.ai/) (World
Labs' 3D-world generator).

It's a plain `.spz`, not an LOD-paged `.rad`, so every splat is resident and drawn
every frame. Fine at this size, and it keeps the example to one file you can point
at your own export — see [`wind/`](../wind) for the LOD-paged route.

> Animated splats re-sort every frame, and sorting means a GPU readback. A
> `SplatGenerator` regenerates by definition, so unlike `wind` this example can't
> avoid that cost — it's inherent to procedural splat particles in Spark. See
> [`wind/README.md`](../wind/README.md) for the detail.
