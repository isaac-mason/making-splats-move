# ocean

An open ocean, nothing captured, and a little sailboat of splats to sail on
it. A fresh breeze's sea under a clear sky, the sun glittering off it ahead,
the clouds in it. The boat rides the swell, leans into its turns and
leaves a frothy wake behind it.

Drawn by [spark-radix][radix] on three.js's `WebGPURenderer`. W/S to sail and
slow, A/D to steer, drag to look round, scroll to come closer. Backtick hides
the splat count.

## The sea

[`src/sea.ts`](src/sea.ts). All splats: a sheet of some 410,000 flat discs
over the water, each moved by the waves and the wake and lit as the water there
would be, every frame. They're a clipmap round the camera, square rings each
twice as big and twice as coarse as the one inside, each ring's grid fixed in
the world so the water doesn't swim; where a ring meets the one inside it, only
the finer one draws, so the two never swap places in the sort and show a seam.
Each splat's a flat Gaussian, wide and overlapping, its middle solid (opacity
past 1) and its rim blending into its neighbours', so the sheet reads as one
smooth surface, not a mosaic.

What moves them is worked out off-screen, on the GPU:

- **The waves** ([`src/waves.ts`](src/waves.ts)): Tessendorf's FFT ocean, the
  way Sea of Thieves makes its sea. A JONSWAP wind-wave spectrum over three
  tiles of 400, 61 and 8 m, 256² each. Every frame each wave's phase is turned
  on by its own speed, and an inverse FFT in compute gives each tile's height,
  its sideways chop (sharp crests, wide troughs), its slope, and how the chop
  squeezes the surface. That's where crests fold over, and where the whitecaps
  are. A splat reads where its bit of water has been carried and which way it
  faces. Waves too fine for a splat its size count as roughness instead.
- **The wake** ([`src/wake.ts`](src/wake.ts)): simulated water round the boat,
  72 m of it on a grid that follows the boat, stepped on the GPU every frame
  with a damped wave equation. The hull pushes the water only as it moves:
  lifted where its waterline arrives, let down where it leaves. Foam is left
  where the waves run steep and in the churn behind the stern, and dies away
  where it was left.
- **The boat floats** on the same waves: a probe samples them where the hull
  feels the water, on the GPU, and reads them back a frame or two late.

Each splat's lit as it's made, after Sea of Thieves: the sky reflected by
Fresnel, clouds and all; the sun's glitter, tight up close and spreading into a
broad path far off; the deep blue-green of the water, darker turned from the
sun, and bright teal where light comes through the crests; whitecaps and the
wake's foam, frothy; the boat's shadow; and haze far off.

## The boat

[`src/boat.ts`](src/boat.ts). A little toon sloop built once out of about
90,000 small splats laid flat along its surfaces, past opaque so they're solid
nearly to their edges: crisp close up among the soft water. Splats are kept
inside each surface's edges, and inside painted outlines like the portholes, so
edges are clean lines rather than a fuzz of discs. Kept simple: a round-bilged
red hull with a white band, a teak rail and plain deck, a cabin with portholes,
a blue roof and a red life ring, a mast and boom, a mainsail with one teal
band, a jib, thin stays, a pennant, and a rudder and tiller. Two toon steps of
shading; the sails are lit from whichever side the light's on.

It floats on the waves probed at its bow, stern and either side, and eases its
height, pitch and roll to match. It leans into turns and lifts its bow at speed.

## The wind

[`src/wind.ts`](src/wind.ts). Cartoon wind, the way Wind Waker and Breath of
the Wild draw a breeze: thin white ribbons zipping downwind over the sea, here
and there. Each runs along its own path, downwind give or take, a gentle
S-curve side to side, rising and dipping as it goes, and about one in three
loops the loop somewhere along it and carries on. The ribbon is a few metres of
that path travelling along it at the wind's speed, head leading and tail
following, tapering to nothing at both ends, fading in as it sets off and out
before it stops. It's a chain of thin splats worked out from its index and the
time; the loop turns across the line of sight, so it's seen face on. Each life
it starts somewhere new round the camera, from just over the water to some nine
metres up, and fades away close to the eye.

## The sky

A deep-blue-to-pale gradient, a small white sun with a warm glow, and clouds: puffs of
noise cut off crisp, on a ceiling over the sea, so they bunch towards the
horizon.

[radix]: https://github.com/asundqui/radix-test
