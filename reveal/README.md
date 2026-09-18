# reveal

A 96MB Gaussian-splat city that puts itself together out of a single point the
moment it finishes downloading.

A ripple of existence spreads out from one point. The front is a wobbling shell, not
a sphere, and it travels: splats don't fly anywhere, they appear where the capture put
them and the wave passing through surges them outward and lets them settle, the way a
ripple moves water without moving it anywhere.

Unrevealed space is sky rather than void — the background is set to very nearly the
blue the capture's own sky splats already are, so the front of the ripple reads as an
edge on the buildings and disappears against the sky, which is what an edge of the
world ought to do.

## The interesting part: splats can be genuinely not drawn

The obvious way to hide a splat is to set its alpha to zero, and Spark gives you that
for free — `SplatEdit` with a `SPHERE` SDF, `invert`, `softEdge` and `opacity` is a
soft-edged reveal in about fifteen lines with no GLSL at all.

That's not what this does, for three reasons found by reading Spark's source:

- **`gsplat.index` is a stable per-splat id.** Hashing it turns the front from a
  clean sphere into a ragged edge, and it's stable frame to frame, so a splat doesn't
  flicker between early and late.
- **`gsplat.center` is writable per splat**, so each one rides the wave along ITS OWN
  radius. `SplatEdit.displace` is a single vector applied to everything inside the
  SDF — it can shove a whole region one way, but every splat would go the same way,
  which is a push rather than a ripple.
- **Clearing `GSPLAT_FLAG_ACTIVE` is real culling.** `computeSort` returns `INFINITY`
  for an inactive splat:

  ```glsl
  float computeSort(Gsplat gsplat, ...) {
    if (!isGsplatActive(gsplat.flags)) {
      return INFINITY;
    }
  ```

  So an unrevealed splat is never sorted and never drawn. The effect costs *least*
  when least of it is showing, which is the opposite of what a fade does.

So it's a `GsplatModifier` on `mesh.objectModifier`, the same hook `wind/` uses for
sway. The whole kernel is about twenty lines of GLSL.

## Loading is real

`SplatMeshOptions` already carries the hooks, which is easy to miss:

```ts
new SplatMesh({
    url: SPLAT_URL,
    onProgress: (event) => setLoadingProgress(loading, event),
});
mesh.initialized.then(() => { finishLoading(loading); startReveal(reveal); });
```

`onProgress` gives a real `ProgressEvent` — with `lengthComputable` false whenever
the server sends no `Content-Length`, which is common enough that "indeterminate" has
to be a real state rather than a bar stuck at zero.

But `initialized` is **not** the moment to lift the overlay — see below.

Deliberately **not** `paged: true`. Paging streams the `.rad` over HTTP range requests
and starts instantly, which is right for [`wind/`](../wind) and exactly wrong here —
the whole demo is the moment a long download lands.

## The thing that actually cost time: the first sort

The reveal looked broken. The overlay would lift and the screen stayed black for
about a second, then the city appeared already half-assembled. Every check said the
wavefront was fine: no shader errors, the radius advancing smoothly in real time, and
freezing it with `?t=0.8` drew exactly the bubble it should.

Logging `spark.activeSplats` against the radius, live, said it in one line:

```
PROBE  200ms radius=2.2  active=0
PROBE  801ms radius=8.8  active=0
PROBE 1201ms radius=12.6 active=0
PROBE 1401ms radius=15.4 active=1090143
```

Spark sorts asynchronously, and the first sort of 2.5M splats takes about 1.3
seconds. Nothing is drawn until it lands — so the opening of the reveal, the part
worth watching, was happening behind a black screen, and by the time anything drew
the front was already 15m out.

The fix is in the shape of the problem rather than a delay. The front holds at a
2.5m `SEED` radius, which is small enough to be nothing but big enough that the
sorter has something to chew on; the clock starts on the first frame where
`spark.activeSplats > 0`; and the loading overlay lifts on that same frame. So the
overlay is now hiding a real wait instead of ending before one.

## Two more things that took a moment to see

**The loading overlay was eating the reveal.** Its background is a near-black
gradient and it faded over 0.8s, so the first second — the part worth watching — was
happening behind it. Screenshots came back black and it looked like the reveal wasn't
starting. It fades in 0.35s now.

**The capture has a viewing envelope.** Pulling the camera back for a wide
establishing shot puts you outside the reconstructed volume, where a street capture
turns into a blue haze of sky splats seen from the wrong side. The framing has to
stay inside the street, which makes the reveal a thing that grows *around* you rather
than something watched from outside.

## Running it

```bash
pnpm --filter reveal dev
```

The asset is shared with [`wind/`](../wind) through `publicDir` in `vite.config.ts`,
because a second copy of a 96MB file in the repository would be 96MB of nothing.

- **backtick** opens the debug panel: click-to-copy camera coordinates, active splat
  count, the front's radius, frame time — and a **replay** button, because watching it
  again shouldn't mean downloading 96MB again
- `?t=2.5` freezes the wavefront at one moment. The only way to judge a still frame
  of something that takes five seconds, and how every number in `reveal.ts` was tuned
- `?cam=x,y,z` / `?look=x,y,z` move the camera
- `?origin=x,y,z` moves the point it all ripples out from

## Where the frame time actually goes

The obvious suspect for a slow animated splat scene is the generator stage. A
`GsplatModifier` regenerates the splat buffer every frame, which invalidates the sort
order, which makes Spark re-sort — and that means a GPU depth readback.
[`wind/`](../wind) patches Spark's draw-time vertex shader specifically to dodge it.

Measured here, against `wind/` rendering the same 96MB city on the same machine at
the same size, it is none of that:

| | frame time | active splats |
| --- | --- | --- |
| no LOD budget | 26.1 ms | — |
| + LOD budget | 21.2 ms | 1,878,054 |
| + LOD, **effect removed entirely** | 22.1 ms | — |
| + LOD, `paged: true` | 22.0 ms | 1,858,775 |
| `wind/` | 9.7 ms | 1,999,999 |

Deleting the ripple doesn't make it faster. Paging doesn't make it faster. And
`wind/` draws *more* splats in less than half the time. So the modifier is free, the
generator stage is the right place for it, and porting it to a draw-time shader would
buy nothing while giving up the `GSPLAT_FLAG_ACTIVE` culling only the generator can do.

It's the **camera**. Same code, same asset, one moved viewpoint:

| | frame time | active splats |
| --- | --- | --- |
| close framing (3 m to the look point) | 21.3 ms | 1,886,660 |
| the wider street framing | 9.4 ms | 1,817,727 |

Fewer splats at the *faster* camera. Splat rendering is fill-rate bound, and a camera
three metres from a wall puts a handful of enormous splats across the whole screen,
many layers deep. Nothing about the effect or the file changes that — only where you
stand. Worth knowing before optimising the wrong end of it.

The LOD budget is still worth having (26.1 -> 21.2 ms for nothing), and lives in
`performance.ts`.

## Tuning notes

The ripple wants a narrow disturbance, not a strong one. The first version pushed
splats 1.4m along their radius and let the wave decay over 7m, and a street is only a
few metres wide — so instead of rippling, the whole front melted. Pulling the
amplitude back to 0.55m and the decay to 2.5m gives a thin travelling band with
everything behind it already settled, which is what a ripple actually looks like.
