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

Good grass wind is coherent and travelling: patterns you can watch cross the
field, not noise boiling in place, and blades with a little weight to them.

- **Gusts**: one broad pattern in the wind's own frame, stretched across it,
  sliding downwind and barely changing shape as it goes, so a gust is a band you
  can follow over the hill. A finer octave slides along with it, and the two map
  gently, so gusts roll rather than switching patches on and off.
- **Weight**: a blade answers the gust that reached it a moment ago and whips back
  past it as the gust lets go. That needs no state: since the pattern only slides,
  what reached a blade a moment ago is the pattern a little downwind of it, and
  how fast it was letting go is the difference between two such samples.
- **Sway**: a gentle ripple running through the grass downwind, neighbours in step,
  each blade only a touch off their rate and phase, so you see ripples pass rather
  than a buzz of separate blades.
- **Lulls and gusts**: how hard it blows rises and falls over tens of seconds, and
  that travels too: a lull rolls across the field with the wind rather than the
  whole field calming at once. The wind veers a little, and taller blades catch
  more of it.

Bent blades show more of their lighter face, so a gust reads as a brighter wave
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
