# fire

A campfire burning under a starry sky. The splat itself never changes on disk —
everything here is done at render time, on top of a static scene:

- **A flame** (`src/flame.ts`), **smoke** (`src/smoke.ts`) and **embers**
  (`src/embers.ts`). Three Gaussian-splat generators running on the GPU with nothing
  stored, all riding one shared curl field so they churn together. See below.

- **Splat-space lighting** (`src/lighting.ts`). Two Spark `SplatEdit` SDFs recolour the
  splats themselves: a tight additive "hot core" at the fire, and a scene-wide
  *multiplicative* one that darkens everything toward a warm gloom (multiply rather
  than add, so it gives the clearing mood without washing out detail). A real
  `THREE.PointLight` rides along for any standard-material mesh you add.
- **Heat shimmer** (`src/heat.ts`). A Spark `worldModifier` — a GPU dyno graph — that
  displaces the scene splats' world positions with upward-scrolling tileable noise
  inside a sphere around the fire. The geometry genuinely wobbles like air over a
  flame, from any angle, rather than being a screen-space filter.
- **Embers** (`src/embers.ts`). Splats too, so they sort with the flame and the
  scene rather than drawing on top of both. They shoot off the coals, coast as they
  cool, and hand themselves to the breeze — dying out somewhere out over the grass
  rather than all at one height, which is what gives the clearing its scale.

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
- **Buoyancy**, driven by the particle's own temperature (below) — because that is
  what buoyancy *is*: hot gas rises because it's less dense than the air around it.
- **Entrainment** — an inward draft, strongest low down. A fire pulls air in to feed
  itself, and that's what necks the column. Without it, buoyancy plus turbulence is
  just a fountain spraying outward.

Velocity then comes out of the integration for free, which is exactly what each
splat needs to be stretched along.

### Carry a temperature, not a colour ramp

Everything you see about a flame — colour, brightness, how hard it climbs — is a
reading of **temperature**, and temperature is a property of where a parcel of gas
has *been*, not of how old it is. Keying colour to age is the most common tell in
procedural fire: a lick flung sideways into cold air and one that shot straight up
the core come out the same shade, so the whole thing reads as an orange shape being
wobbled rather than as gas burning.

So the advection carries a temperature scalar too, and only two things happen to it:

- **Combustion** adds heat while there's still fuel left in the parcel, for the first
  ~30% of its life. That's why a real fire is brightest a little *above* the wood,
  with a darker pyrolysis gap beneath — the gas has to travel before it has finished
  burning. Here the dark base falls out of the model instead of being painted on.
- **Mixing** takes it away again, and this is where the structure in the colour comes
  from, because it is emphatically not uniform. Out at the edge a parcel meets cold
  air directly; in the core it's shielded by the hot gas around it. Strong shear folds
  air in faster. So the core stays white while anything flung clear goes dark red —
  *per tongue*, not per clock. (Use `exp(-rate * dt)` for the decay: it's the one
  thing Euler gets badly wrong at six steps, and the closed form is exact and
  unconditionally stable.)

Brightness is then `pow(temp, glowFalloff)`. Luminosity of the soot continuum goes as
roughly T⁴, which is why the core of a real fire blows out a camera while the tips
barely register; without tone mapping the full exponent is too brutal, so it's a dial.

> A trap that cost a tall flame: parameterise the walk by *progress-to-now* —
> `through = (k + 0.5) / STEPS` — and every profile you write collapses into its own
> average. The displacement works out to `elapsed × mean(v)` no matter what shape `v`
> has, so an acceleration produces a constant speed. It has to be a fraction of the
> particle's **full lifetime** (`× age`) to be a clock at all.

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
  reads the fire's value for the current frame, which is right when the thing you're
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

> The trap that actually ate the smoke's fade, though, is in the renderer. Spark
> **culls a splat outright** once its alpha falls below `minAlpha` — the whole splat,
> in the vertex stage, not a per-fragment discard — and the default is `0.5/255`. At
> the opacities smoke needs, that fired at 43% of a puff's life while it was still at
> a *third* of peak: not a fade, a pop, and at a different moment per puff, since each
> carries its own birth heat. Lower it, and pair that with fewer, stronger splats —
> what you see is `count` × `opacity`, so halving the population and doubling the
> alpha is the same column, twice as far above the cull, and half the sorting work.

Two smaller things: key wind shear and eddy strength to **height above the fire, not
age**, or two puffs side by side feel different wind and the plume shears into
strands; and carry `pos.y` in the gust phase so a lull travels *up* the column
instead of the whole plume leaning as one.

## The fire signal

Every effect above reads one shared number instead of animating independently, which
is what makes them swell *together*. `src/fire.ts` owns it:

- `intensity` — the sustained 0..1 burn level, rising when stoked and decaying back to
  a resting baseline.
- `pulse` — a transient that ramps up on each stoke and eases down, so effects can
  react to the *blast* on top of the sustained level.

Nobody tends the fire, so it looks after itself: it settles at a resting burn and
throws in small random crackles every few seconds. **Click or tap anywhere**
to throw another log on — watch the clearing brighten, the air ripple, the flame leap
and the embers fly.

The camera is the fixed framing plus a parallax lean toward the cursor
(`src/camera-drift.ts`) — free orbiting is a measuring tool rather than a feature of
the scene, so it lives behind the debug panel.

Press **`` ` ``** for that panel: an **orbit camera** toggle (which stands the lean
down while it's on, and puts the shot back when you turn it off), camera readout, a
fire-heat override slider, the LOD budget, SDF light wireframes, and click-to-raycast
for measuring the world-space landmarks in `src/scene.ts`.

## Layout

| File | Role |
| --- | --- |
| `src/scene.ts` | Everything specific to *this* world: asset URL, camera framing, where the fire is. Swapping in a new scene is a one-file edit. |
| `src/fire.ts` | The shared fire signal, and what drives it — resting burn, crackles, stokes. |
| `src/flame.ts` | The flame body: particles advected through the velocity field, carrying a temperature. |
| `src/smoke.ts` | Smoke above it — long-lived, expanding, cooling to nothing; reads the fire signal *delayed*. |
| `src/embers.ts` | Sparks lifting off, riding the same field. |
| `src/curl.ts` | The shared curl noise, so all three churn together. |
| `src/lighting.ts`, `src/heat.ts` | Fire lighting and the heat-shimmer plume, each reading the signal. |
| `src/interaction.ts` | Tap-to-stoke (tap, not drag — OrbitControls owns dragging). |
| `src/camera-drift.ts` | Parallax lean toward the cursor while hovering, so the clearing reads as a space rather than a photo. |
| `src/debug.ts`, `src/performance.ts` | Debug panel and runtime quality knobs. |

## Assets

The scene came from [Marble](https://marble.worldlabs.ai/) (World Labs' 3D-world
generator), exported as a `.spz` splat.

- `assets/campfire.spz` — the source splat (28 MB). Not served: only the LOD file is.
- `public/campfire-lod.rad` — the LOD-paged build (39 MB), what the browser loads.

Rebuild the `.rad` from the source with (needs a [Rust toolchain][rust] —
`build-lod` ships only in Spark's source repo, so the script shallow-clones it into
a gitignored `vendor/`):

```bash
pnpm build:lod
```

The `.rad` is *bigger* than the `.spz` it came from, which is the point: it carries
a level-of-detail pyramid rather than one flat list, so the renderer can draw a
cheap version of what's far away. A flat `.spz` has nothing to choose between, so
every splat is resident and drawn every frame and the LOD budget in
`src/performance.ts` — and the debug panel's `lod scale` slider — do nothing at all.

Two things are easy to get wrong here:

- **`paged: true` on the `SplatMesh` *streams* the `.rad`** rather than loading it
  resident. It isn't needed to read the file: `.rad` is an auto-detected format, and
  the LOD tree is encoded in it, so `new SplatMesh({ url })` alone already gives you
  LOD (Spark's docs note `lod: true` is unnecessary for a `.rad` for the same
  reason). What the flag buys is instant start and the paging budget —
  `pagedExtSplats` / `maxPagedSplats` only exist once a `SplatPager` does.
- **Paging uses HTTP range requests** to pull pages out of the `.rad`, so whatever
  serves it has to support them. This applies only when paged.

> All the world-space landmarks in `src/scene.ts` — the fire origin, the flame
> origin, where embers leave — were measured with the debug raycast: press
> **`` ` ``**, click a point, read the `hit` line. Swap the scene and that's the
> loop for re-finding them.

[rust]: https://rustup.rs/
