# making-splats-move

| Example | What it does |
| --- | --- |
| [`fire/`](fire) | A campfire under a starry sky: a procedural splat flame, splat-space lighting, heat shimmer and embers. |
| [`wind/`](wind) | Trees swaying in a splat city: foliage displaced in Spark's draw-time splat shader, with an edit mode for placing the volumes. |
| [`dust/`](dust) | Dust motes drifting through a splat greenhouse: a stateless procedural particle generator. |

## Quick start

Requires **Node 24+**, **pnpm**, and **[git-lfs][lfs]** (the splat assets are stored
in LFS — see [Assets](#assets)).

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

## Assets

Splat files are big, so `.spz`, `.rad`, `.ply` and `.ksplat` are tracked with **git
LFS** (see [`.gitattributes`](.gitattributes)). If you clone without git-lfs
installed you'll get small pointer text files instead of splats and the examples
will fail to load — install git-lfs and run `git lfs pull`.

Per example, the convention is:

- `assets/` — source splats, **not served**. The originals, kept so derived files can
  be rebuilt.
- `public/` — what the browser actually downloads (e.g. the LOD-paged `.rad`).

[spark]: https://github.com/sparkjsdev/spark
[three]: https://threejs.org
[lfs]: https://git-lfs.com
