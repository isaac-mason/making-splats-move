# snowglobe

The anime city's street crossing as a snow globe: cut into a diorama, under
glass. Snow drifts down through the globe and settles on its roofs, awnings and
streets; press space to shake it, and the snow whirls up and slowly settles
again.

Drawn by [spark-radix][radix] on three.js's `WebGPURenderer`. Space shakes it
(hold it to keep shaking); drag to orbit, right-drag or shift-drag to pan,
scroll to move in.

## The diorama

The capture (the same one as [`wind/`](../wind) and [`reveal/`](../reveal)) was
shot from the street, so it never saw the tops and backs of its buildings: from
above they're smears of sky. A snow globe is looked down into, so the city is cut
like a miniature model: a disc 28 m across round the crossing, sliced off just
above the shopfronts, its sky floaters dropped, and the faint splats and the
ones too small to see from outside the glass (offline, the diorama looked the
same without them). [`scripts/crop-city.mjs`](scripts/crop-city.mjs) does that
once, to its own `.spz`: 730,000 of the city's 4.3 million splats, 11 MB. The cut
is [`diorama.json`](diorama.json), shared by the app and both scripts.

The glass is a sphere drawn after the splats, barely there: a faint rim where
you look across it and a small soft highlight, so the city shows through.

## The snow's collider

Snow lands on top surfaces, so what it needs is a heightfield, not a mesh:
[`scripts/bake-heights.mjs`](scripts/bake-heights.mjs) reads the cut capture
and, every 25 cm across the diorama, keeps the height of the top of what's solid
there (a high percentile of its fairly opaque splats, so a lone floater doesn't
count, median-filtered), 57 KB. It's the method of the collider in
lively-crossing, read straight off the splats; that collider itself is cropped to
head height for walking, so it has no roofs.

## The snow

48,000 flakes simulated on the GPU, in the globe's own frame. A flake is carried
by the fluid and sinks through it slowly (about a metre a second at the city's
scale), eased towards that every step, as a flake is all drag. The fluid is
still until shaken: a shake gives it energy, which drives a swirl (curl noise, so
it stirs without bunching) and a slow spin of the whole fluid about the glass's
axis, dying away over a few seconds. The globe's own motion pushes the flakes the
other way, as the fluid lags behind the glass.

A flake reaching the city stops on the heightfield (past the cut, the diorama's
base), and the glass holds the rest in. Landing gently while the fluid is calm, it
settles and stays, lying flatter, so the roofs and the street whiten; a hard
enough shake lifts settled flakes back into the flow.

## Shaking

Each press of space (and each repeat while it's held) jolts the globe sideways,
a different way each time, and it's held on a spring, a little underdamped, so
it wobbles back; the city, the glass and the snow move together. The spring's
acceleration is what stirs the fluid and pushes the flakes.

## Without compute

On the WebGL2 backend there's no simulation: snow just falls through the glass
forever, each flake worked out from its index and the time.

[radix]: https://github.com/asundqui/radix-test
