# grass

A meadow at golden hour, and nothing in it was captured. The ground and every
blade of grass are splats generated on the GPU from their index and the time, so
the wind costs nothing extra: each frame makes every blade afresh, already bent.

Drawn by [spark-radix][radix] on three.js's `WebGPURenderer`. Drag to look around.

## A blade

A blade is five splats strung along a curve from root to tip: long along the
blade, a narrow strip across it, paper thin. The curve is a quadratic Bézier whose
tip leans by the blade's own rest lean plus the wind, so it bends from the root and
curls most at the tip. Each blade is turned about its own length at random, so the
field catches the light at every angle.

The blades are laid out on a sunflower spiral, which spreads any number of points
evenly with no clumps or gaps, crowded a little towards the middle where you stand.
Far blades draw wider with distance, so the far field fills in rather than thinning
to sub-pixel threads.

## The wind

- **A breeze** every blade feels all the time.
- **Gusts**: noise sliding downwind across the field and slowly changing shape, so
  they travel as waves rather than pulsing in place.
- **A shiver** per blade, quick and small, stronger in a gust.

Bent blades show more of their lighter face, so a gust reads as a brighter wave
rolling through the grass.

## The light

The sun sits low beyond the field, so the field is backlit: blade tips glow when
you look towards the sun, and roots darken down in the thatch. The far field fades
into a haze that is exactly the sky's horizon colour, so the field's edge
disappears. The sun's disc is bright enough for the bloom to find it.

## Layout

| File | Role |
| --- | --- |
| `src/field.ts` | The ground, the blades and the wind, with every tunable at the top. |
| `src/index.ts` | The sky, the shot, the post pass and the loop. |

[radix]: https://github.com/asundqui/radix-test
