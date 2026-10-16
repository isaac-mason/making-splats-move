# grass

Rolling hills of long grass on a summer afternoon, and nothing in it was captured.
The hills and every blade of grass are splats generated on the GPU from their
index and the time, so the wind costs nothing extra: each frame makes every blade
afresh, already bent. Cloud shadows sweep across the hills.

Drawn by [spark-radix][radix] on three.js's `WebGPURenderer`. Drag to look around,
right-drag to move.

## A blade

A blade is five splats strung along a curve from root to tip: long along the
blade, a narrow strip across it, paper thin. The curve is a quadratic Bézier whose
tip leans by the blade's own rest lean plus the wind, so it bends from the root and
curls most at the tip. Each blade is turned about its own length at random, so the
field catches the light at every angle.

The blades are scattered at random, crowded a little towards the middle where you
stand. Random on purpose: it clumps a little, as grass does, where any evenly
spread scheme shows its pattern as a lattice across a field. The randomness is
three's PCG integer hash, since a cheap float hash of neighbouring indices
correlates in just the same way.

Far blades draw wider with distance, the ground between them turns grass-coloured,
and blade-to-blade colour variety calms down, so the far field reads as turf
rather than a grain of separate threads.

## The hills

A few long sine swells at odd angles: the long ones make the hills, the short ones
the lumps on them. It's the same sum on the CPU, so the camera can stand on a
hilltop and stay above the grass as you drag it round. The ground's splats lie on
the slope, and both they and the blades are lit by the hillside's angle to the
sun, which is what makes the hills read.

## The wind

The wind has weather. How hard it blows rises and falls over tens of seconds,
from a lull where the grass barely stirs to gusts that lay it over, and in it:

- **Fronts**: noise in the wind's own frame, stretched across it and sliding
  downwind with a sharp leading edge, so a gust arrives as a band combing over the
  hills. They travel faster when it's blowing hard.
- **Cat's paws**: small quick patches skittering across the grass at an angle to
  the wind, the ripples between gusts.
- **Swirl**: the wind's direction wanders across the field, so waves curl rather
  than all leaning one way.
- **A shiver** per blade, quick and small, stronger in a gust.
- **It veers**, slowly. Everything moving with it is carried by the integrated
  wind, so a change of direction or strength never makes anything jump.

Bent blades show more of their lighter face, so a front reads as a brighter wave
rolling through the grass.

## The clouds' shadows

The cloud is a picture: one cloud on white (`assets/cloud.jpg`, from the grass
sketch this grew out of), tiled in two layers at different sizes, angles and
speeds, so the clouds never line up into a grid, with clear sky between them. It
lies at cloud height and is never drawn. Each blade looks up from where it stands
towards the sun to that layer, and where a cloud is in the way it loses its warm
sunlight and keeps only the blue skylight. So all you see of the clouds is their
shapes sliding over the hills.

## The light

Sun on each blade's face and on the hillside it grows from, blue skylight in
shadow, light through the blades when you look towards the sun, and roots dark down
in the thatch. The far field fades into a haze that is exactly the sky's horizon
colour, so the field's edge disappears.

## Layout

| File | Role |
| --- | --- |
| `src/field.ts` | The hills, the blades, the wind and the clouds, with every tunable at the top. |
| `src/index.ts` | The sky, the shot, the post pass and the loop. |

[radix]: https://github.com/asundqui/radix-test
