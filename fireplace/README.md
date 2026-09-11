# fireplace

A fire burning in a Gaussian-splat boiler room. The splat itself never changes on
disk — everything here is done at render time, on top of a static scene:

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

## The fire signal

Every effect above reads one shared number instead of animating independently, which
is what makes them swell *together*. `src/furnace.ts` owns it:

- `intensity` — the sustained 0..1 burn level, rising when stoked and decaying back to
  a resting baseline.
- `pulse` — a transient that ramps up on each stoke and eases down, so effects can
  react to the *blast* on top of the sustained level.

`src/fire.ts` drives that signal: it holds the resting burn, throws in small random
crackles every few seconds, and meters out the ember trickle. **Click or tap anywhere**
to throw another log on — watch the room brighten, the air ripple and the embers fly.

Press **`` ` ``** for a debug panel: camera readout, a fire-heat override slider, the
LOD budget, SDF light wireframes, and click-to-raycast for measuring the world-space
landmarks in `src/scene.ts`.

## Layout

| File | Role |
| --- | --- |
| `src/scene.ts` | Everything specific to *this* world: asset URL, camera framing, where the fire is. Swapping in a new scene is a one-file edit. |
| `src/furnace.ts` | The shared fire signal. |
| `src/fire.ts` | What drives that signal — resting burn, crackles, ember trickle. |
| `src/lighting.ts`, `src/heat.ts`, `src/dust.ts`, `src/sparks.ts` | The effects, each reading the signal. |
| `src/interaction.ts` | Tap-to-stoke (tap, not drag — OrbitControls owns dragging). |
| `src/debug.ts`, `src/performance.ts` | Debug panel and runtime quality knobs. |

## Assets

The scene came from [Marble](https://marble.worldlabs.ai/) (World Labs' 3D-world
generator), exported as a `.spz` splat.

- `assets/boiler-room.spz` — the source splat. Not served.
- `public/boiler-room-lod.rad` — what the browser loads: an LOD-paged build of the
  above, so Spark streams detail in instead of downloading 2.7M splats up front.

To rebuild the `.rad` after changing the source (needs a [Rust toolchain][rust] —
`build-lod` ships only in Spark's source repo, so the script shallow-clones it):

```bash
pnpm build:lod
```

> `paged: true` is **required** on the `SplatMesh` for a `.rad`. Without it Spark falls
> back to its `PackedSplats` path, which has no `.rad` decoder, and nothing streams in.

[rust]: https://rustup.rs/
