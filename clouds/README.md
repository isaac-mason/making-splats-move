# clouds

A glide through broken cumulus at golden hour, and nothing in it was captured.
Every splat is generated on the GPU from its index and the time.

Drawn by [spark-radix][radix] on three.js's `WebGPURenderer`. Grab it any time:
drag to orbit, right-drag or shift-drag to pan, scroll to move. Let go, and after
a few seconds the glide eases back in.

## The take

What splats bring that a painted sky can't is **parallax**: clouds you move
past. So the camera flies, forever, but under the deck, never in it. A sky this
full has no lanes through its middle (an earlier cut flew through the layer and
spent half its time inside cloud), so it glides 90–110 m beneath the flat bases (any nearer and the bases' splats are
big enough on screen to read as a blur) at
17 m/s, looking 21° up so the clouds fill the frame: bases sweeping overhead, towers stacking towards the
horizon, the land below. It holds a heading that keeps the low sun ahead and to
one side, weaving either way on two slow sines and banking into the turns, with
a gentle rise and fall on a third. The field of clouds wraps round the camera, so
there is no end and no loop seam.

The sun sits 13° up, warm. Its line of sight from under the deck has to cross the
whole cloud layer, so it hides, and peeks out through the gaps by itself, and
every time it does, shafts fan out. Clouds facing it go gold at the edges, the
far sides stay a cool blue-grey. Clouds closer than about 20 m fade out, so
flying into one with the controls is a wisp of mist, not a wall of splats.

Grab the view and the orbit controls take it, pivoting on a point 80 m ahead.
Let go, and five seconds later the glide picks up where it paused and eases back
in over four.

## The land

Far below, drawn by the sky shader where the view ray meets the ground, and kept
quiet: it's there for scale and to catch the clouds' shadows. One dusky green
drifting towards olive over kilometres (nothing small enough to shimmer at a
grazing angle), fading into the same haze as the sky's horizon. Each cloud casts
a soft **shadow** on it: the ray up from the ground towards the sun is followed to
the cloud layer, and the same hash that places the splats says which clouds are
there, seen from below as one disc per dome. So patches of sun and shade drift
across the land under clouds you can see.

## A cloud

A cloud is a **density field**. Its envelope is four domes on one flat base: a
big one in the middle, three smaller towers leaning off it. Billowy noise pushes lumps out of
that envelope: inverted Worley noise for the biggest octave, a round bump on every
cell, which are the cauliflower heads, then |Perlin| for the creases and knobbles
on them. The noise is calmer low down,
so the base stays flat and sharp, and it rises slowly through the cloud, so the
lumps roll upwards and boil.

Splats go where they show. Most sit on the **skin**: each starts anywhere in its
dome and takes one Newton step along the dome's radius onto the surface the noise
makes (the envelope falls by one per dome radius, so the step is just the surface
function's value), landing a little way in. A cloud's splats are then small, about
2–3 m apart, and spent on its lumps rather than its hidden middle. Some lie flat
across the **base**, which the skin doesn't reach, and a few big ones fill the
**core**, so the skin never shows daylight through. Each takes its opacity from
the density where it lands, and the edge ramps in over only a few metres, so the
silhouette is crisp and the silver lining thin.

Each skin splat knows the surface's **normal**, from the gradient of the surface
function at four points on a tetrahedron. It lies along it as a disc a third as
thick as it is wide, so an edge seen side-on is a crisp line, and the normal
shades it: facing the sun brighter, facing away darker (except backlit, where
edges should glow), facing up lit by the sky, facing down by the land. That's
what lets the lumps read one by one instead of melting into one white.

The bloom only takes what's past white, so the sun blooms and the clouds don't:
blooming clouds was most of the blurry halo round them.

The middle dome is the biggest, so it gets 40% of the splats and each tower 20%.

Each cloud lives on its own slow cycle, two to four minutes round, its edge eaten
further away and then filling back in, so clouds swell and thin, and the gaps the
sun shows through open and close. A hundred clouds sit one to a cell of a 10 × 10
grid, each wider than its cell, so neighbours merge into banks with blue between.
The grid wraps around you: what drifts off downwind comes back in upwind, out
beyond the haze.

## The light

Every splat **marches towards the sun** through its own cloud and keeps what gets
through (Beer-Lambert): two short steps through the noise, where the detail is,
then three long ones through the bare envelope (no noise, so they're nearly free) to
reach the far side of a 150 m cloud. Sides away from the sun, the bases and the
thick middles fall into the cloud's own shadow, thick clouds darker than thin.
On top of that:

- **multiple scattering**, the cheap way (after Wrenninge): four copies of the
  sun, each half as bright, through cloud thinner each time, scattered less
  forward each time. Light that has bounced around inside is most of what you see
  on a cloud's shadowed side; without it that side is a flat, dead grey;

- a **phase function**, two Henyey-Greensteins, mostly even with a forward lobe,
  so cloud edges go silver when you look towards the sun;
- the **powder effect**: thin sun-facing skins a touch darker than just inside,
  which shades the creases between lumps. It fades out when backlit, where
  edges should glow instead;
- blue **skylight** from above and a dim, warm **bounce** from the land below, both
  dimmer deep inside.

The lighting is done in linear and encoded at the end; sunlit tops land just
past white, so the bloom softens them. Far clouds fade into the horizon colour.

## Shafts and the grade

The post pass takes what is past white near the sun on screen (open sky round its
disc) and blurs it along lines out from the sun, so light streams from wherever
the sky shows through. It is a screen-space trick and knows nothing of depth, so
it fades out as you turn away from the sun. Bloom takes only what's past white
too: the sun, not the clouds. Then a vignette and a warm lift.

## What it costs, and what's next

The generator runs every frame for every splat: a million splats, each
evaluating the noisy surface eight times (once to find the skin, once where it
lands, four for its normal, two for the light), each with a Worley octave. That is the honest first version, there to get the look.
Ways on from here:

- **Bake the light.** The sun and the clouds change slowly, so the march could
  move into a radix compute pass (the fire example has the pattern) that writes
  light into a buffer and refreshes a slice of it a frame.
- **Shadows between clouds**: march into a neighbour as well as your own. On a day
  this cloudy it matters: a cloud in another's shadow should be grey all over.
- **Far clouds as fewer, bigger splats**: the old flight-sim impostor trick, for
  the bank on the horizon, from the same density so the shapes agree.
- **Skylight by what's overhead**: a step or two upwards, so the tops of lumps
  catch the sky and their undersides don't, which rounds each lump even backlit.

## Layout

| File | Role |
| --- | --- |
| `src/clouds.ts` | The density field, the splats that sample it, the light march and the drift, and the clouds' shadow on the land, with every tunable at the top. |
| `src/index.ts` | The glide and its hand-off to the controls, the sky and the land, the post pass and the loop. |

[radix]: https://github.com/asundqui/radix-test
