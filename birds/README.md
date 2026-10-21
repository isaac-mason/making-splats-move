# birds

A murmuration at dusk: eight thousand starlings wheeling overhead, nothing
captured. Every bird is simulated on the GPU and drawn as a little bird of seven
splats.

Drawn by [spark-radix][radix] on three.js's `WebGPURenderer`. Your cursor is a
hawk: the birds part wide round it, and swipe it through the flock and the ones
it startles scatter, the fright running out across the whole flock in a wave.
Drag to orbit the flock, right-drag or shift-drag to pan, scroll to move in among
the birds; let go, and after a few seconds you're eased back to looking up.

## The take

You lie back and look up. The sun has just gone, its glow low at the bottom of
the sky, the first stars out overhead, and the flock pours, folds and turns
itself inside out above you, roaming round the sky. The view follows it slowly,
never quite catching it. Every thirteen seconds a falcon dives through and the
flock flashes open round it.

## The flock

Starlings don't hold a shape, so nothing here gives them one. Each bird steers
towards where the flock is carrying it: round the roost, wheeling on an axis that
leans and at a rate that slows, stops and reverses, plus a swirl of curl noise
drifting through the flock. A curl has no divergence, so it stretches the flock
into sheets and folds them over each other without bunching it anywhere. The
darkness is all in the folds.

Each bird also flies with its neighbours: it turns towards their mean velocity,
and edges out of anywhere packed past twice the usual. The neighbours are a grid
round the roost that every bird adds its velocity into (cloud-in-cell, atomic
adds in fixed point), then reads back from, so no bird looks at another one by
one. Three dispatches a frame: clear the grid, scatter into it, fly. It holds a
speed, stays inside a soft envelope round the roost, and banks into its turns,
so when the flock turns its birds go edge-on together and it flashes.

## Fright

The agitation waves of a real murmuration: a band racing across the flock faster
than any bird flies. A startled bird's alarm rises over a fifth of a second, and
while it rises it's catching, added into the grid alongside the velocities; a
bird whose neighbours' alarm averages past a threshold is startled in turn. Then
its alarm falls and for four seconds it can't be startled again, so a fright
runs out as a band, about 45 m/s, and never comes back round (an excitable
medium, like a grass fire). Alarmed birds dodge away from where the alarm came
from, bank into the dodge and flap hard, so the band shows. The falcon starts
one on every pass; so does a fast swipe of the cursor. Tried out first on a CPU
copy of the flock: contagious for the whole of its alarm rather than just the
rise, the fright kept relighting behind itself and circling.

## A bird

Built like the meadow's butterflies in [`grass/`](../grass): a body, a head and a
fanned tail, and on each side an inner wing hinged at the shoulder and a pointed
hand hinged at its tip, swept back. The wings beat about five times a second
(slow enough not to alias into a shimmer), the hand lagging the arm so the stroke
whips, in bursts between glides with the wings held out. Near-black against the
dusk, the wings lit amber where the glow is behind them.

## Without compute

On the WebGL2 backend there are no compute kernels, so there's no simulation:
each bird is a point in a ball that wheels and swirls round the roost, worked
out from its index and the time. The flock churns rather than flies.

[radix]: https://github.com/asundqui/radix-test
