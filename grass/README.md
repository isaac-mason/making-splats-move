# grass

Rolling hills of long grass on a summer afternoon, and nothing in it was captured.
The hills and every blade of grass are splats generated on the GPU from their
index and the time, so the wind costs nothing extra: each frame makes every blade
afresh, already bent. Clouds drift over, and their shadows sweep across the hills.

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

## The hills

A few long sine swells at odd angles: the long ones make the hills, the short ones
the lumps on them. It's the same sum on the CPU, so the camera can stand on a
hilltop and stay above the grass as you drag it round. The ground's splats lie on
the slope, and both they and the blades are lit by the hillside's angle to the
sun, which is what makes the hills read.

## The wind

- **A breeze** every blade feels all the time.
- **Fronts**: noise in the wind's own frame, stretched across it and sliding
  downwind, so gusts are long bands combing over the hills rather than blobs.
- **A shiver** per blade, quick and small, stronger in a front.
- **It veers**, slowly, a little either side. Gusts and clouds are carried by the
  integrated wind, so a change of direction never makes them jump.

Bent blades show more of their lighter face, so a front reads as a brighter wave
rolling through the grass.

## The clouds and their shadows

One cover field at cloud height, drifting with the wind. The sky draws it where
each view ray meets the cloud layer. The grass looks up from where it stands
towards the sun to the same layer, and a cloud there takes away its sunlight,
leaving the blue skylight. So every shadow sweeping over the hills is cast by a
cloud you can see, and a cloud over the sun dims its disc.

## The light

Sun on each blade's face and on the hillside it grows from, blue skylight in
shadow, light through the blades when you look towards the sun, and roots dark down
in the thatch. The far field fades into a haze that is exactly the sky's horizon
colour, so the field's edge disappears.

## Layout

| File | Role |
| --- | --- |
| `src/field.ts` | The hills, the blades, the wind and the clouds, with every tunable at the top. |
| `src/index.ts` | The sky and its clouds, the shot, the post pass and the loop. |

[radix]: https://github.com/asundqui/radix-test
