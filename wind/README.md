# wind

Trees swaying in a Gaussian-splat city street. The splat file is untouched — the
foliage moves because every splat's centre is displaced on the GPU, once per frame,
by a **per-splat modifier**.

## How it works

`src/wind.ts` is the whole idea. It's Spark's answer to PlayCanvas's
`gsplatModifyVS` / `modifySplatCenter` wind demo: a `GsplatModifier` dyno graph
assigned to `SplatMesh.objectModifier`, which runs once per splat in the generator,
receives a `Gsplat`, and returns a modified one. We split it, add a time-driven sway
offset to the centre, and recombine. Time is free — `SplatMesh.dynoTime` is a static
uniform Spark updates every frame.

```
sway  = sin(time * speed + center.x * 0.7 + center.z * 0.7)
offset = vec3(sway * amplitude, 0, ...) * mask
```

**Which splats sway** is the interesting half, and it's `mask`. A whole city can't
sway — the road and the buildings have to stay put. So the foliage is selected by
hand, with authored sphere volumes (`WIND_SPHERES`): a splat inside a sphere sways
fully, feathering to zero at its edge, and a splat in no sphere never moves. The
spheres are baked into the generated GLSL as constants, since they're authored
rather than dynamic. Overlapping spheres take `max`, never a sum — a splat in two
spheres must not be double-displaced and flung out of the tree.

Press **`` ` ``** for the debug panel and tick **wind sphere debug** to see the
volumes drawn over the scene; that plus click-to-raycast (and the click-to-copy
coordinate readout) is how the sphere list gets authored in the first place.

## The one gotcha

An object modifier only re-runs when the mesh's version bumps, and Spark bumps that
on camera/transform changes. Left alone, the trees would sway only while you moved
the camera and freeze the moment you stopped. So `applyWind` marks the mesh dirty
every frame:

```ts
mesh.onFrame = () => { mesh.needsUpdate = true; };
```

That regenerates the whole splat buffer each frame — Spark has no partial regen —
which is the inherent price of an animated modifier.

## Layout

| File | Role |
| --- | --- |
| `src/wind.ts` | The sway modifier and the authored wind volumes. |
| `src/splat.ts` | SparkRenderer + SplatMesh setup, with the wind attached. |
| `src/scene.ts` | Everything specific to *this* world: asset URL and camera framing. |
| `src/performance.ts` | LOD paging + quality budget, tuned per platform. |
| `src/debug.ts` | The panel: wind-sphere wireframes, LOD sliders, click-to-copy readout. |

## Assets

The scene came from [Marble](https://marble.worldlabs.ai/) (World Labs' 3D-world
generator), exported as a `.spz` splat.

- `public/anime-city-lod.rad` — what the browser loads: an LOD-paged build of that
  splat, so Spark streams detail in instead of downloading it all up front.

The 66MB source `.spz` is **not** in this repo — it's a large LFS object that only
matters if you want to rebuild the `.rad`, and the built file is the one the example
needs. To rebuild, drop the source in `assets/` and run `pnpm build:lod` (needs a
[Rust toolchain][rust] — `build-lod` ships only in Spark's source repo, so the script
shallow-clones it).

> `paged: true` is **required** on the `SplatMesh` for a `.rad`. Without it Spark
> falls back to its `PackedSplats` path, which has no `.rad` decoder, and the paging
> budget in `src/performance.ts` is inert. Paging streams pages over HTTP range
> requests, so the host must support them.

[rust]: https://rustup.rs/
