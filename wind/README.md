# wind

Trees swaying in a Gaussian-splat city street. The splat file is untouched — the
foliage moves because every splat's centre is displaced on the GPU, every frame.

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
best-looking splat wind going. The kernel lives once, in
[`src/wind-sway.ts`](src/wind-sway.ts), shared by both render paths below.

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

## Two ways to move the splats

| | default | `?generator=1` |
| --- | --- | --- |
| Where | Spark's draw-time splat shader | a dyno `objectModifier` |
| Splat buffer | never regenerated | regenerated every frame |
| Sort | stale by one displacement | always correct |
| File | [`src/wind-drawtime.ts`](src/wind-drawtime.ts) | [`src/wind.ts`](src/wind.ts) |

**The modifier path is the idiomatic one** — it's what most of Spark's own examples
do, it composes, and its sort is always right. It's kept, one URL flag away, and
it's the one to reach for first in your own work.

**But it costs far more than it looks**, and that's the interesting part. Moving a
splat invalidates the sort order it was placed in, so Spark re-sorts — and sorting
means reading depths back from the GPU via `readRenderTargetPixelsAsync`. That
readback stalls the pipeline for tens of milliseconds on alternating frames. The
chain is:

```
mesh.needsUpdate = true  →  version bump  →  regenerate  →  sortDirty  →  re-sort  →  GPU readback stall
```

The regeneration itself isn't the problem. The **forced re-sort** is. The draw-time
path never marks the buffer dirty, so none of that chain fires — which is why it
wins by much more than "skipping a compute pass" would suggest.

> Beware of averaging when you measure this. A 50 ms stall every other frame hides
> completely in a rolling mean (~18 ms), which is how it went unnoticed here at
> first. Look at a frame-time *graph*, or `window.__windStats` in the console.

### What draw-time gives up

- **The sort is computed from undisplaced positions.** Fine at these amplitudes;
  crank `strength` far up and blending order starts to go wrong.
- **It's global to the renderer.** One splat shader draws the *whole* accumulated
  buffer, every visible mesh merged. This scene has exactly one mesh, so everything
  in the buffer is ours. With more, gate on the splat's index against the
  `{ base, count }` range for your mesh in `SplatAccumulator.mapping`.
- **It doesn't compose.** Modifiers stack; a patched shader doesn't.

### How the patch works

Spark supports this directly — `SparkRendererOptions.vertexShader` replaces the
splat shader and `extraUniforms` merges into its uniform map. But rather than
vendoring a copy of `splatVertex.glsl` (270 lines of ExtSplats / CovSplats / LOD /
2DGS handling you'd then own forever), we string-replace the shader on the live
material and let Spark ship whatever it likes:

```ts
spark.material.vertexShader = spark.material.vertexShader.replace(anchor, injected);
spark.material.needsUpdate = true;  // forces a recompile
```

Three things bit while building this, all worth knowing before you try it:

1. **Anchor on code, not comments.** The published build strips comments out of the
   GLSL, so a comment anchor silently matches nothing. Assert the replace actually
   happened, or a Spark upgrade turns the wind off with no error.
2. **Spark's built-in `time` uniform is frozen here.** It's assigned from
   `spark.display.time`, which only advances when a generate happens — so on the
   path whose whole purpose is to avoid generating, it never ticks. Drive your own.
3. **The accumulated buffer is not in world space.** For float precision Spark
   offsets it by the camera's position at generation time
   (`accumToWorld.makeTranslation(display.viewOrigin)`), so world-space volumes
   miss by however far the camera is from the origin. Add the origin back before
   testing against anything authored.

## Edit mode

Placing volumes by editing a literal and reloading is miserable: you can't see what
a sphere caught, and a tree is only right when the leaves move and the trunk
doesn't. Press **`` ` ``** for the debug panel, tick **wind edit mode**:

- **Every splat the wind claims is tinted**, brightening toward the canopy — so
  "which leaves does this actually move" is something you look at rather than
  guess. Included splats go **red** (nothing in a daylit street is red, so it can't
  be mistaken for the scene) and the volume you're editing goes **yellow**. Both
  stay strongly tinted; selection changes the hue, not whether you can see the rest.
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
| `src/wind-sway.ts` | The sway kernel as GLSL, shared by both paths. |
| `src/wind-drawtime.ts` | Default path: patches Spark's splat shader. |
| `src/wind.ts` | `?generator=1` path: a dyno `objectModifier`. Owns the shared types. |
| `src/wind-editor.ts` | Edit mode: gizmo, volume list, sliders, JSON round-trip. |
| `src/splat.ts` | SparkRenderer + SplatMesh setup. |
| `src/scene.ts` | Asset URL and camera framing. |
| `src/performance.ts` | LOD paging + quality budget, tuned per platform. |
| `src/debug.ts`, `src/stats.ts` | Debug panel and frame-time readout. |

## Assets

The scene came from [Marble](https://marble.worldlabs.ai/) (World Labs' 3D-world
generator), exported as a `.spz` splat.

- `assets/anime-city.spz` — the source splat. Not served.
- `public/anime-city-lod.rad` — what the browser loads: an LOD-paged build of the
  above, so Spark streams detail in instead of downloading it all up front.

To rebuild the `.rad` after changing the source (needs a [Rust toolchain][rust] —
`build-lod` ships only in Spark's source repo, so the script shallow-clones it):

```bash
pnpm build:lod
```

> `paged: true` is **required** on the `SplatMesh` for a `.rad`. Without it Spark
> falls back to its `PackedSplats` path, which has no `.rad` decoder, and the paging
> budget in `src/performance.ts` is inert. Paging streams pages over HTTP range
> requests, so the host must support them.

[rust]: https://rustup.rs/
