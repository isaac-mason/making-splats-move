# making-splats-move

| Example | What it does |
| --- | --- |
| [`reveal/`](reveal) | A splat city that assembles itself from a single point: a wavefront ripples outward, surging splats into place as it passes. |
| [`wind/`](wind) | Trees swaying in a splat city: foliage displaced by a TSL splat modifier, with an edit mode for placing the volumes. |
| [`dust/`](dust) | Dust motes drifting through a splat greenhouse: a stateless procedural particle generator. |
| [`fire/`](fire) | A campfire under a starry sky: a procedural splat flame, splat-space lighting, heat shimmer and embers. |
| [`avatars/`](avatars) | Procedural rigged characters built out of splats, dual-quaternion skinned by a splat generator and walking around a town square. |
| [`avatars-parts/`](avatars-parts) | How the avatars are drawn, in five short files: splat shapes, a face built from them, a body, that body skinned, and a flower that bends. The version to read first. |

## Quick start

Requires **Node 24+**, **pnpm**, and **[git-lfs][lfs]** (the splat assets are stored
in LFS — see [Assets](#assets)).

```bash
git lfs install       # once per machine
pnpm install          # also builds spark-radix from source, see below
pnpm dev              # runs fire/ → http://localhost:5173
```

Other commands:

```bash
pnpm build            # build every example
pnpm lint             # biome check
pnpm check            # biome check --write (autofix)
```

To work on one example directly:

```bash
pnpm --filter fire dev
```

## The renderer

Everything draws with **[spark-radix][radix]**: Gaussian splats on three.js r186's
`WebGPURenderer`, on WebGPU or its WebGL2 backend (`?gpu=webgpu-gl` on any example
forces the latter). The effects are radix *generators* and *modifiers* written in
three's TSL, and the fire's simulation is WebGPU compute through radix's kernels.

Radix is a pinned GitHub dependency: the commit hash lives in the `catalog` of
[`pnpm-workspace.yaml`](pnpm-workspace.yaml), every example depends on
`spark-radix: catalog:`, and pnpm builds it from source on install (the package's
own `prepare` script, allowed through `onlyBuiltDependencies`). To move to a newer
radix, change the hash there and run `pnpm install`. `three` is pinned to 0.186.x
across the workspace, radix's peer dependency.

## Assets

Splat files are big, so `.spz`, `.rad`, `.ply` and `.ksplat` are tracked with **git
LFS** (see [`.gitattributes`](.gitattributes)). If you clone without git-lfs
installed you'll get small pointer text files instead of splats and the examples
will fail to load — install git-lfs and run `git lfs pull`.

Each example loads its splats from its own `assets/` as `.spz`, through Vite's
`?url` import.

[radix]: https://github.com/asundqui/radix-test
[three]: https://threejs.org
[lfs]: https://git-lfs.com
