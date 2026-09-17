# fire

A campfire burning under a starry sky. The splat itself never changes on disk —
everything here is done at render time, on top of a static scene:

- **A flame** (`src/flame.ts`), **smoke** (`src/smoke.ts`) and **embers**
  (`src/embers.ts`). Three Gaussian-splat generators running on the GPU with nothing
  stored, all riding one shared curl field so they churn together. See below.

- **Splat-space lighting** (`src/lighting.ts`). Two Spark `SplatEdit` SDFs recolour the
  splats themselves: a tight additive "hot core" at the fire, and a room-wide
  *multiplicative* one that darkens everything toward a warm gloom (multiply rather
  than add, so it gives the room mood without washing out detail). A real
  `THREE.PointLight` rides along for any standard-material mesh you add.
- **Heat shimmer** (`src/heat.ts`). A Spark `worldModifier` — a GPU dyno graph — that
  displaces the scene splats' world positions with upward-scrolling tileable noise
  inside a sphere around the fire. The geometry genuinely wobbles like air over a
  flame, from any angle, rather than being a screen-space filter.
- **Dust** (`src/dust.ts`). 2,500 motes generated as a second `SplatMesh`, not a
  `THREE.Points` cloud — so they sort and blend with the environment splats (a mote
  behind a wall is properly hidden) and the fire's SDF light tints them for free. A
  `worldModifier` drifts each one; no per-frame CPU work.
- **Embers** (`src/sparks.ts`). A pooled, additively-blended `THREE.Points` system:
  a steady trickle off the coals that thickens with the heat, plus a burst on a stoke.

## The flame

The scene's own fire is baked into the photograph, so it can only ever brighten.
`src/flame.ts` puts actual burning geometry on the logs instead — and being splats
rather than a `THREE.Points` cloud is what lets it sit *in* the firepit, sorted and
blended with the scene's own splats.

It's stateless in the same way as [`dust/`](../dust) — hash the splat index for a
stable seed, evaluate a closed-form function of (seed, time) — with one addition. A
flame particle has a **lifetime**, which would normally mean tracking birth and
death per particle. Instead its age is itself a `fract()`:

```glsl
float age = fract(seed * 7.13 + time * speed);
```

Every particle sweeps 0..1 forever, wrapping back to newborn, with seeds spreading
the population evenly across all ages. The same recycling trick as the dust field,
applied to time instead of space — and the last reason to keep a particle buffer.

### Advect, don't displace

The first several attempts sampled a noise field and displaced each particle by it.
That gives erratic, stringy motion: as the field changes the particle is teleported
around rather than carried. Worse, an earlier version bound particles to fixed
*tongues* — shared lanes that whipped together — which is a rope, not a fluid, and
looked like one.

What fire sims actually do is **advect**: integrate the particle along a velocity
field from birth to now. A handful of Euler steps in the shader is enough, and it
changes everything, because the field is what produces the structure:

- **Curl noise** for turbulence, sampled where the particle *is*. It's
  divergence-free, so particles swirl past each other instead of piling into sinks,
  and neighbours stay neighbours — which is what lets tongues form on their own
  instead of being hard-coded. The curl of a *sine* potential is analytic, so a few
  cosines give an exact field without the usual six noise samples.
- **Buoyancy** that builds as the gas heats and fades as it cools near the top.
- **Entrainment** — an inward draft, strongest low down. A fire pulls air in to feed
  itself, and that's what necks the column. Without it, buoyancy plus turbulence is
  just a fountain spraying outward.

Velocity then comes out of the integration for free, which is exactly what each
splat needs to be stretched along.

Three more things mattered far more than expected while tuning it:

- **Low alpha, not high.** Fire is emissive: two overlapping tongues should add up.
  Spark blends premultiplied, so a bright colour at a *small* alpha approximates
  additive blending. Raise it and the flame stops being fire and becomes an orange
  lozenge, because alpha blending resolves overlap by showing only the nearest splat.
- **Premultiply the smoke, but not the flame.** Same blend mode, opposite needs.
  Writing a straight colour gets you that additive glow, which is right for flame
  and embers and wrong for smoke — additive smoke can only ever brighten, so it
  glows and takes on the hue of whatever it drifts across (over a dark treeline it
  goes visibly green). Writing `col * alpha` gives ordinary compositing, so smoke
  occludes and keeps its own grey.
- **Solve for the accumulated alpha, don't guess it.** What you see along a view ray
  is `1 - (1 - a)^n` over n overlapping splats. Forty smoke puffs at a = 0.035 comes
  out at 0.83 — a solid black column. For a wisp reading about 0.35, a is nearer
  0.01. Guessing at this costs several rounds; the arithmetic takes one.
- **Many small splats, not few big ones.** You see *through* a flame; the structure
  comes from thousands of thin tongues accumulating.
- **Speed.** Fire is far quicker than feels right in a parameter file — a lick of
  flame exists for well under a second. Short lifetimes plus heavy curl is the
  standard recipe.

> Watch out for two traps here. Naming a variable `sample` is a **GLSL ES 3.00
> reserved word**, and Spark swallows generator compile errors silently — so the
> effect vanishes completely with nothing in the console. And raw curl carries the
> wave-vector magnitudes (~4), so normalise it or your turbulence parameter is in
> mystery units and any sane value flings particles out of the scene.

## The smoke

`src/smoke.ts` is a second generator rather than more parameters on the flame,
because smoke does almost the opposite of what a flame tongue does: it lives ten
seconds instead of a fraction of one, it expands the whole way instead of swelling
and collapsing, and it cools to nothing instead of glowing.

That one difference — smoke is **slow** — is what makes the two failure modes here
different from the flame's.

- **Advect here too, and take many more steps.** A single noise sample used as a
  displacement is a static warp: the puff sits on a fixed path that the field
  wiggles, so the column reads as a rope taped to the fire rather than a gas
  rolling over itself. The fix is the same integration the flame uses, but the trip
  is ~30x longer in seconds, so it needs ~24 steps rather than four. What has to
  stay small is the distance covered per step against the size of an eddy, not the
  step count.
- **Turbulence cannot widen a plume.** Curl noise is divergence-free — that's the
  property that makes it good at stirring — so it moves a column around without
  expanding it, and a stirred pencil-thin column is still pencil-thin. Real smoke
  widens because it **entrains**: it drags cold air in across its surface and opens
  into a cone of roughly 10-15 degrees. That's an explicit outward velocity, tied to
  the rise speed so the angle stays constant. It's the flame's inward draft with the
  sign flipped: fire necks in, its smoke opens out.
- **Long-lived particles need the fire signal *delayed*.** Everything else here
  reads the furnace value for the current frame, which is right when the thing you're
  driving lives for a fraction of a second. Multiply a ten-second puff's height by
  the current heat and stoking the fire re-scales the whole column at once — every
  puff in the sky lurches upward together, which is the most artificial thing smoke
  can do. What a puff actually carries is the heat of the fire *at the moment it left
  it*, so the smoke keeps 20s of the signal in a scrolling 128-byte `R8` texture and
  each puff looks up its own birth time (`elapsed = age / speed`) with one filtered
  fetch. A stoke then travels up the column as a denser, faster gout, which is the
  thing you were trying to draw in the first place.
- **Let the height be emergent.** Once birth heat is doing that job, a `height`
  parameter actively gets in the way: it can only ever be applied to every puff at
  once. Where the column tops out falls out of the integral of a decaying rise speed
  over a lifetime instead, which is also why the top of the plume is a ragged front
  rather than a ceiling — lifetimes vary per puff.

Two smaller things: key wind shear and eddy strength to **height above the fire, not
age**, or two puffs side by side feel different wind and the plume shears into
strands; and carry `pos.y` in the gust phase so a lull travels *up* the column
instead of the whole plume leaning as one.

## The fire signal

Every effect above reads one shared number instead of animating independently, which
is what makes them swell *together*. `src/furnace.ts` owns it:

- `intensity` — the sustained 0..1 burn level, rising when stoked and decaying back to
  a resting baseline.
- `pulse` — a transient that ramps up on each stoke and eases down, so effects can
  react to the *blast* on top of the sustained level.

`src/fire.ts` drives that signal: it holds the resting burn, throws in small random
crackles every few seconds, and meters out the ember trickle. **Click or tap anywhere**
to throw another log on — watch the clearing brighten, the air ripple, the flame leap
and the embers fly.

Press **`` ` ``** for a debug panel: camera readout, a fire-heat override slider, the
LOD budget, SDF light wireframes, and click-to-raycast for measuring the world-space
landmarks in `src/scene.ts`.

## Layout

| File | Role |
| --- | --- |
| `src/scene.ts` | Everything specific to *this* world: asset URL, camera framing, where the fire is. Swapping in a new scene is a one-file edit. |
| `src/furnace.ts` | The shared fire signal. |
| `src/fire.ts` | What drives that signal — resting burn, crackles, ember trickle. |
| `src/flame.ts` | The flame body: particles advected through the velocity field. |
| `src/smoke.ts` | Smoke above it — long-lived, expanding, cooling to nothing; reads the fire signal *delayed*. |
| `src/embers.ts` | Sparks lifting off, riding the same field. |
| `src/curl.ts` | The shared curl noise, so all three churn together. |
| `src/lighting.ts`, `src/heat.ts`, `src/dust.ts` | Lighting, shimmer and drifting dust, each reading the signal. |
| `src/interaction.ts` | Tap-to-stoke (tap, not drag — OrbitControls owns dragging). |
| `src/debug.ts`, `src/performance.ts` | Debug panel and runtime quality knobs. |

## Assets

The scene came from [Marble](https://marble.worldlabs.ai/) (World Labs' 3D-world
generator), exported as a `.spz` splat.

- `assets/campfire.spz` — the source splat.
- `public/campfire.spz` — what the browser loads.

It's a plain `.spz` for now, so every splat is resident and drawn each frame. To
bake an LOD-paged `.rad` instead (needs a [Rust toolchain][rust] — `build-lod` ships
only in Spark's source repo, so the script shallow-clones it):

```bash
pnpm build:lod
```

...then point `SPLAT_URL` at the `.rad` and pass `paged: true` to the `SplatMesh`.
That flag is **required** for a `.rad`: without it Spark falls back to its
`PackedSplats` path, which has no `.rad` decoder, and nothing streams in.

> All the world-space landmarks in `src/scene.ts` — the fire origin, the flame
> origin, where embers leave — were measured with the debug raycast: press
> **`` ` ``**, click a point, read the `hit` line. Swap the scene and that's the
> loop for re-finding them.

[rust]: https://rustup.rs/
