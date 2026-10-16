# fire

A campfire burning under a starry sky, drawn by [spark-radix][radix] on three.js's
`WebGPURenderer`. The splat itself never changes on disk — everything here is done
at render time, on top of a static scene:

- **The fire** (`src/sim.ts`). On WebGPU, a small fluid simulation in compute
  kernels: a 40×96×40 grid of air over the coal bed carries heat, soot and velocity
  (advection, buoyancy, vorticity confinement, a pressure solve, open sides and
  top), and the flame, smoke and embers are particles with state of their own that
  ride it. Flame particles carry a temperature that sets their colour on a
  blackbody-ish ramp, white through yellow and orange to red and soot.
- **The stateless fire** (`src/flame.ts`, `src/smoke.ts`, `src/embers.ts`). The
  same three as TSL generators with nothing stored, all riding one shared curl
  field. It's what runs where there's no compute (the WebGL2 backend, or
  `?sim=0`), and the design story below is its story.
- **Splat-space lighting** (`src/lighting.ts`). A TSL modifier on the capture's own
  generator recolours the scene's splats: a tight additive hot core at the fire, a
  scene-wide *multiplicative* darkening toward a warm gloom (multiply rather than
  add, so it gives the clearing mood without washing out detail), and directional
  firelight from each splat's normal.
- **Heat shimmer** (`src/heat.ts`). A second modifier on the capture that displaces
  the scene's splats with scrolling noise in a column of hot air over the fire. The
  geometry genuinely wobbles like air over a flame, from any angle, rather than
  being a screen-space filter.
- **Embers** are splats too, so they sort with the flame and the scene rather than
  drawing on top of both. They shoot off the coals, coast as they cool, and hand
  themselves to the breeze — dying out over the grass rather than all at one height,
  which is what gives the clearing its scale.
- **Fireflies** (`src/fireflies.ts`) flash in the dark past the fire: a bright core
  splat and a faint halo each, on a closed-form wander.
- **Post** (`src/post.ts`). three's `RenderPipeline` with a bloom and a vignette.
  Radix keeps colour above 1 through the splat encoding, so the flame's white core
  is genuinely bright and the bloom has something to find.

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

A few more things mattered far more than expected while tuning it, first on Spark
and still true on radix:

- **Low alpha, not high.** Fire is emissive: two overlapping tongues should add up.
  Splats blend premultiplied, so a bright colour at a *small* alpha approximates
  additive blending. Raise it and the flame stops being fire and becomes an orange
  lozenge, because alpha blending resolves overlap by showing only the nearest splat.
- **Never premultiply in the generator.** The renderer premultiplies itself, so
  writing `col * alpha` squares the alpha: smoke turns into a near-black filter tinted
  by whatever's behind it. Write straight colour, and make the smoke darker than the
  sky behind it so it shades rather than glows.
- **Solve for the accumulated alpha, don't guess it.** What you see along a view ray
  is `1 - (1 - a)^n` over n overlapping splats. Forty smoke puffs at a = 0.035 comes
  out at 0.83 — a solid black column. For a wisp reading about 0.35, a is nearer
  0.01. Guessing at this costs several rounds; the arithmetic takes one.
- **Many small splats, not few big ones.** You see *through* a flame; the structure
  comes from thousands of thin tongues accumulating.
- **Speed.** Fire is far quicker than feels right in a parameter file — a lick of
  flame exists for well under a second. Short lifetimes plus heavy curl is the
  standard recipe.

> Watch out for two traps here. In the Spark version's GLSL, naming a variable
> `sample` hit a **GLSL ES 3.00 reserved word**, and Spark swallowed generator
> compile errors silently, so the effect vanished with nothing in the console. And raw curl carries the
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
  is ~30x longer in seconds, so it needs 24 steps rather than six. What has to
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

> The trap that actually ate the smoke's fade, though, is in the renderer. It
> **culls a splat outright** once its alpha falls below `minAlpha` — the whole splat,
> in the vertex stage, not a per-fragment discard — and Spark's default was `0.5/255`
> (here it's set on the `SplatRenderer`). At
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
down while it's on, and puts the shot back when you turn it off), camera readout,
layer toggles, fire-heat, night and bloom sliders, render scale, light helpers, and
click-to-raycast for measuring the world-space landmarks in `src/scene.ts`.

## Recording

`?record=1` renders a take straight to an MP4 and downloads it. It isn't a screen
recording: every frame is rendered on a fixed clock, exactly 1/120 s after the last,
at 1920×1080 whatever the window, so the file is perfectly smooth at a rate the
display couldn't show. Frames go from the canvas into the hardware encoder through
WebCodecs and are muxed in the page with `mp4-muxer`.

The take itself is designed in `src/record.ts`, not in the URL: the fire burns
through a warmup before the first frame, gets one stoke a third of the way in, and
the camera sways once across and back, ending where it began so the clip loops.
`fps`, `width`, `height` and `mbps` change the output format.

## Layout

| File | Role |
| --- | --- |
| `src/scene.ts` | Everything specific to *this* world: asset URL, camera framing, where the fire is. Swapping in a new scene is a one-file edit. |
| `src/fire.ts` | The shared fire signal, and what drives it — resting burn, crackles, stokes. |
| `src/sim.ts` | The WebGPU compute fire: the air grid, and the flame, smoke and ember particles that ride it. |
| `src/flame.ts`, `src/smoke.ts`, `src/embers.ts` | The stateless fire, for where there's no compute. |
| `src/tsl.ts` | What the generators share: the time uniform, the curl noise, hashing. |
| `src/coals.ts`, `src/fireflies.ts` | The glowing bed under the flame, and the glints past it. |
| `src/air.ts` | The breeze and gusts everything drifts in. |
| `src/lighting.ts`, `src/heat.ts` | Firelight and the heat-shimmer plume, as modifiers on the capture. |
| `src/post.ts` | Bloom and vignette. |
| `src/record.ts` | The recording mode and the take's design. |
| `src/interaction.ts` | Tap-to-stoke (tap, not drag — OrbitControls owns dragging). |
| `src/camera-drift.ts` | Parallax lean toward the cursor while hovering, so the clearing reads as a space rather than a photo. |
| `src/debug.ts`, `src/raycast.ts`, `src/performance.ts` | Debug panel, its splat picker, and render scale. |

## Assets

The scene came from [Marble](https://marble.worldlabs.ai/) (World Labs' 3D-world
generator), exported as a `.spz` splat.

`assets/campfire.spz` (28 MB) is what the browser loads, flat: radix draws every
splat every frame and has no level-of-detail paging yet.

> All the world-space landmarks in `src/scene.ts` — the fire origin, the flame
> origin, where embers leave — were measured with the debug raycast: press
> **`` ` ``**, click a point, read the `hit` line. Swap the scene and that's the
> loop for re-finding them.

[radix]: https://github.com/asundqui/radix-test
