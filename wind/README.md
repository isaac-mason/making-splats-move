# wind

Trees swaying in a Gaussian-splat city street. The splat file is untouched — the
foliage moves because every splat's centre is displaced on the GPU, every frame.

Drawn by [spark-radix](https://github.com/asundqui/radix-test) on three.js's
`WebGPURenderer`: WebGPU where there is one, its WebGL2 backend elsewhere (or
with `?gpu=webgpu-gl` to force it).

## Which splats sway

A city can't sway as a whole; the road and buildings have to stay put. So foliage
is selected by hand with authored sphere volumes, and each **tree** is one or more
spheres:

- A sphere's **base anchors the trunk** and its top is the canopy, so sway scales
  with height within the tree, as `pow(height, 1.3)` — the cantilever bend of a
  real trunk rather than a rigid slab sliding sideways.
- Sway feathers out radially near each sphere's surface, so a tree doesn't end at
  a hard spherical cut.
- A splat inside several spheres takes the **strongest**, never the sum — summing
  would displace it twice and fling it out of the tree.

On top of that: a per-tree golden-ratio phase so neighbouring trees never fall into
step, a `waveTravel` term lagging the canopy behind the trunk so the bend visibly
travels up, a slow `gustiness` swell, and a fast cross-wind `flutter` seeded from
`height * 17.0` so the canopy shimmers leaf-by-leaf instead of sliding as a sheet.

The model is ported from PlayCanvas's
[`GsplatTrees`](https://github.com/playcanvas/engine/pull/9022), which is the
best-looking splat wind going. The kernel lives once, as two TSL functions in
[`src/wind-sway.ts`](src/wind-sway.ts): how strongly one sphere claims a point,
and the displacement for a point once its tree is known.

### Trees, not spheres

A tall canopy usually wants several stacked spheres. Spheres sharing a `tree` id
are one tree: they share a phase, and measure height from their **combined** base
and top. Without that, splats either side of the crossover swing out of step and
shear the canopy in half — measurably, a jump of 0.166 world units between points
2cm apart, against a total sway amplitude of 0.18. Grouped, that drops to 0.001.

Two things follow, both easy to trip over while authoring:

- **Stacked spheres of one tree must overlap.** A splat in no sphere is unclaimed,
  so a gap leaves a frozen stripe through a moving canopy — which reads far worse
  than a seam.
- **Moving one sphere retunes its siblings**, because height is measured across the
  whole tree. Drag the lower sphere down and the upper canopy's sway changes too.

Spheres of *different* trees may overlap freely. The seam is real (two trees should
move independently) and self-limiting: a slight overlap sits in both spheres'
feather zones, where sway is low anyway.

## How the splats move

Radix has no vertex-shader hook to patch; what it has instead is a **generator**.
The capture's splats are stored arrays on the GPU, and the generator is the TSL
program that makes splat `i` from them, once per splat, every render. It takes a
list of **modifiers**: TSL functions that receive a splat and return a changed
one, run in turn after the load. The wind is one such modifier, on the stored
splats' generator —

```ts
SplatGenerator.fromSplats({ modifiers: [wind.modifier] })
```

— so there is one code path, and it lives in [`src/wind.ts`](src/wind.ts). It
runs in the capture's object space, and the capture sits at the origin, so that
is world space: the volumes are authored in the coordinates the modifier sees,
with nothing to add back.

**The spheres are uniforms, not constants.** They live in two 64-slot
`uniformArray`s — centre and radius in one, each sphere's tree (id, base, top)
in the other — with a count. The modifier loops over the count, scores every
sphere against the splat with the kernel, and keeps the best; only then does it
compute a displacement, from the winning tree's phase and height. Because the
arrays are uniforms, the editor can drag a sphere and the tint and sway follow
the same frame, with no shader recompile. The 64 is the only limit, and it's a
shader array size rather than anything the editor knows about.

**It's cheap, which is new.** In Spark, where this example began, moving a splat
from a modifier meant regenerating the splat buffer, which marked the sort dirty,
which forced a re-sort — and the sort read depths back from the GPU, stalling for
tens of milliseconds on alternating frames. The only way round it was a patched
draw-time shader whose displacement the sort never saw. Radix projects the whole
collection every render regardless, so a modifier adds a few instructions to a
pass that was running anyway, and the sort is a different story:

- **On WebGPU** the sort runs on the GPU in the same frame, from the projected
  (already swayed) splats, and the draw is indirect. Nothing is read back. The
  blend order is right every frame, at any `strength`.
- **On the WebGL2 backend** the sort keys are read back and sorted on a worker,
  and by default a sort is only triggered by the camera or the collection
  changing — neither of which a wind does. So while anything moves the app asks
  for a sort every frame; the order drawn is at most a sort or two behind the
  sway, which at these amplitudes doesn't show.

> `window.__windStats` is a rolling half-second mean of the frame time, which is
> the wrong instrument for spikes: a 50 ms stall every other frame hides
> completely in an ~18 ms average. It's what let the Spark readback go unnoticed
> at first. For anything spiky, look at a frame-time *graph*.

## The camera

The shipped camera is the fixed framing from `src/scene.ts` plus a slow tilt toward
the cursor (`src/camera-drift.ts`) — enough to make the city read as somewhere
you're standing rather than a photograph, small enough that you don't quite notice
it. Mouse only: a touch screen has no hover, so phones get the plain framing.

**Tilt, not translate**, and the two are different effects rather than two spellings
of one. Shifting the eye without re-aiming is *parallax*: near things slide against
far things, which is the cue that sells depth — but it needs near things to slide.
Rotating in place is a *pan*: nothing is revealed, but it costs nothing to see,
because what you perceive is the angle swept. Which wins is a property of the scene.
The [`fire/`](../fire) example translates, because its subject is a few units away
and the logs visibly slide against the treeline. Here the nearest thing is eleven
units off with the whole city behind it, so the same shift buys almost no relative
motion — you'd move the camera and get nothing for it. A couple of degrees of pan
moves the frame by a few percent of its height and reads immediately.

Free orbiting is a framing and authoring tool rather than a feature of the scene,
so it lives behind the debug panel's **orbit camera** toggle. Turning it on stands
the lean down; turning it off puts the shot back, since the orbit camera will have
left the camera wherever your last drag ended. **wind edit mode** ticks it on for
you — authoring volumes means flying around to look at them.

> Rotating is the easier of the two to bolt onto OrbitControls, as it happens.
> `update()` recomputes the camera's orientation from `position` and `target` every
> frame, so a rotation applied afterwards is simply overwritten next frame — it
> can't compound, and nothing has to be backed out. A position offset is the awkward
> case: OrbitControls derives its spherical state *from* `camera.position`, so an
> offset added on top becomes part of that state and creeps. `fire/`'s copy has to
> subtract its offset before `update()` and re-apply it after.
>
> The other owner is the wind editor, which borrows `controls.enabled` during gizmo
> drags — a gizmo drag and an orbit drag are the same gesture. It has to restore the
> *toggle's* value afterwards rather than hardcoding `true`, or you end up orbiting
> with the box unticked.

## Edit mode

Placing volumes by editing a literal and reloading is miserable: you can't see what
a sphere caught, and a tree is only right when the leaves move and the trunk
doesn't. Press **`` ` ``** for the debug panel, tick **wind edit mode**:

- **Every splat the wind claims is tinted**, brightening toward the canopy — so
  "which leaves does this actually move" is something you look at rather than
  guess. Included splats go **red** (nothing in a daylit street is red, so it can't
  be mistaken for the scene) and the volume you're editing goes **yellow**. Both
  stay strongly tinted; selection changes the hue, not whether you can see the rest.
  The tint is the same modifier writing the splat's colour as well as its centre,
  so it can't disagree with the sway about who's in. Untick **highlight leaves**
  to preview the motion untinted, or **wind** to hold everything still.
- **A gizmo** on the selected volume: `g` to translate, `r` to scale. The tint
  updates as you drag, because the spheres are uniforms rather than constants.
  (Scale by gizmo is touchy near its centre — three derives the factor from a ratio
  of distances to the gizmo origin — so there's a **radius** box for exact sizes.)
- **A tree box** to group stacked spheres, and add/remove/select plus live sliders
  for every wind parameter.
- **Three rings per volume**, not a wireframe sphere: a wireframe is a few hundred
  segments of chicken wire across the very splats you're trying to judge.
- **A JSON box** emitting exactly the shape of [`src/wind.json`](src/wind.json),
  which is where the scene's volumes and parameters actually live. Authoring is:
  open edit mode, drag until it looks right, copy, paste over that file.

## Layout

| File | Role |
| --- | --- |
| `src/wind.json` | The authored volumes and wind parameters — the editor's own format. |
| `src/wind-sway.ts` | The sway kernel as TSL: one sphere's claim on a point, and the displacement. |
| `src/wind.ts` | The modifier: sphere uniforms, best-sphere loop, sway and tint. Owns the types. |
| `src/wind-editor.ts` | Edit mode: gizmo, volume list, sliders, JSON round-trip. |
| `src/splat.ts` | Loads the capture and puts it in a `SplatRenderer`, modifier on its generator. |
| `src/scene.ts` | Asset URL and camera framing. |
| `src/performance.ts` | The render-scale knob, pushed onto the renderer each frame. |
| `src/debug.ts`, `src/stats.ts` | Debug panel and the `window.__windStats` frame-time readout. |
| `src/camera-drift.ts` | Tilt toward the cursor; free orbiting is behind the panel's toggle. |

## Assets

The scene came from [Marble](https://marble.worldlabs.ai/) (World Labs' 3D-world
generator), exported as a `.spz` splat.

- `assets/anime-city.spz` — the capture, imported by `src/scene.ts` and bundled
  by Vite. It's loaded flat: decoded on a worker, uploaded as GPU arrays, and
  every splat draws every frame.

> Radix reads `.rad` files but doesn't yet select LoD subsets or page them in, so
> an LoD-paged build of the capture would have nothing to gain here — which is why
> this example no longer ships one.
