# making-splats-move

| Example | What it does |
| --- | --- |
| [`reveal/`](reveal) | A splat city that assembles itself from a single point as a wavefront ripples outward. |
| [`wind/`](wind) | Trees swaying in a splat city, with an edit mode for placing the volumes. |
| [`dust/`](dust) | Dust motes drifting through a splat greenhouse. |
| [`fire/`](fire) | A campfire under a starry sky: procedural splat flame, firelight, heat shimmer and embers. |
| [`avatars/`](avatars) | Procedural rigged characters built from splats, walking around a town square. |
| [`avatars-parts/`](avatars-parts) | How the avatars are drawn, in five short files. Read this one first. |
| [`grass/`](grass) | An endless meadow with nothing captured: walk it in third person and trample a path, through splat grass combed by the wind, drifts of wildflowers, butterflies and cloud shadows. |
| [`clouds/`](clouds) | A glide under broken cumulus at golden hour, nothing captured. |
| [`hair/`](hair) | Long blonde hair streaming in a sea breeze at golden hour: simulated guide strands grown into splat hair on the GPU. |
| [`birds/`](birds) | A murmuration of eight thousand starlings at dusk, simulated on the GPU. |
| [`tree/`](tree) | A tree grown from a seed, its canopy sprays of splat leaves, blown by the wind. |
| [`fireworks/`](fireworks) | A fireworks show of eight shell kinds over dark hills, every spark a splat. |
| [`confetti/`](confetti) | A confetti gun in your hand: paper flutters down and piles up. |
| [`snowglobe/`](snowglobe) | The anime city as a snow globe, with GPU snow settling on its roofs. |
| [`time/`](time) | The avatars' courtyard relit through a whole day, sun, shadows and moonlight. |
| [`rain/`](rain) | A downpour over the same courtyard: soaked paving, puddles and splashes. |
| [`ocean/`](ocean) | An open ocean of splats and a little sailboat of splats to sail on it: a sheet of 410,000 splats moved by an FFT ocean and a simulated wake, both on the GPU, lit after Sea of Thieves, the boat floating on the very waves drawn. |

## Quick start

Requires **Node 24+**, **pnpm** and **[git-lfs][lfs]** (splat assets live in LFS).

```bash
git lfs install       # once per machine
pnpm install
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

Everything draws with **[Radix][radix]** on three.js r186's `WebGPURenderer`, on WebGPU or its WebGL2 backend (`?gpu=webgpu-gl` forces the latter). Its version lives in the `catalog` of [`pnpm-workspace.yaml`](pnpm-workspace.yaml).

## Assets

Splat files (`.spz`, `.rad`, `.ply`, `.ksplat`) are tracked with **git LFS** (see [`.gitattributes`](.gitattributes)). Without git-lfs you get pointer files and the examples fail to load: install it and run `git lfs pull`.

[radix]: https://sparkjs.dev/radix/
[three]: https://threejs.org
[lfs]: https://git-lfs.com
