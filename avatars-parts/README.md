# avatars-parts

How the [avatars](../avatars) are drawn, cut down to five short files you can read
top to bottom. No capture, no assets: just splats pushed into a `SplatMesh`.

```bash
pnpm --filter avatars-parts dev    # ?step=1 to 5, or use the buttons
```

1. **[`1-shapes.ts`](src/1-shapes.ts)** — one splat is a small, flat Gaussian disc.
   Lay thousands of them tangent to a surface and you get a shell: a sphere (spread
   evenly with a Fibonacci spiral, and squared off towards a box with `roundness`),
   a capsule, or a filled disc (spread as a sunflower).
2. **[`2-face.ts`](src/2-face.ts)** — a face is flat discs on a sphere, each stacked a
   little further out than the one below, so the sort can't swap them: outline,
   white, pupil, shine. The smile is a row of small splats along a curve.
3. **[`3-body.ts`](src/3-body.ts)** — the default avatar, Mo, rebuilt from those: a
   rounded box for the torso (shirt above the hem, trousers below), capsules for
   limbs, and the hair as a slightly bigger head kept only above a hairline — low at
   the back, a toothed fringe at the front.
4. **[`4-skinning.ts`](src/4-skinning.ts)** — the same body with one bone per part.
   Each splat follows the bone of the part that built it, and Spark's `SplatSkinning`
   moves them on the GPU: swing a bone and its splats follow. He waves with a forearm
   bone parented to the upper arm, so it turns inside it.
5. **[`5-bend.ts`](src/5-bend.ts)** — a flower on a chain of four bones up its stem,
   for the other half of skinning: each splat is shared between its two nearest bones,
   so the stem bends instead of hinging.

**show bones** (or `?bones`) draws the skeleton over steps 4 and 5
([`skeleton.ts`](src/skeleton.ts)), moved by the same transforms as the splats.

The real avatars add a proper skeleton (bones chained, blended weights at the joints),
layered shells for crisp silhouettes, and decals that wrap the curve of the head. See
[avatars](../avatars).
