# tree

A tree, and nothing in it was captured: grown from a seed on the CPU and drawn
as splats, every leaf one you can see, blown by the wind. Under a plain summer
sky. Drag to orbit, right-drag or shift-drag to pan, scroll to move in.

Drawn by [spark-radix][radix] on three.js's `WebGPURenderer`.

## The shape

Canopy first. A Ghibli tree's canopy is a few big masses made of rounder
clumps, so that's what's placed: eight masses round a dome (one crowning it, the
rest in a ring at alternating heights), each with seven to ten clumps over its
top and outer side. Then the wood grows up into them: a flared trunk forks three
ways, each fork reaching towards the masses nearest its way, then a limb wanders
into each mass and a twig into each clump, each branch four gnarled pieces
sharing its girth out between its children (da Vinci's rule). Tried first
offline: grown branch-first, the canopy fell apart into a clump per limb.

## Leaves

Leaves grow in sprays: a twig poking out through a clump's skin, wherever it
isn't buried inside another clump, with nine leaves alternating along it in a
plane facing out and up, smaller towards its tip. So the canopy's edge is
sprays of leaves, not a smooth curve or a fuzz.

Each leaf is cartoon-big (about 25 cm long) so it reads as a leaf from where
you stand: a teardrop of two splats, a broad one at its base and a narrow one at
its tip, with a solid middle and a feathered edge (opacity a little past 1 with
`lodInflate` off, which radix draws with a firmer falloff). Hard-edged leaves
(opacity 2, a crisp ellipse about 4.3 standard deviations out) read best as
leaves standing still, but splats are sorted by their centres, and as the wind
moved them the sort kept swapping which of two overlapping leaves was in front,
so they popped; plain soft Gaussians blended but melted into fronds. Feathered,
an overlap is a blend, and a swap barely shows.

A leaf's light is its spray's (how its clump, its mass and the whole canopy
face the sun, times what gets through the other clumps, Beer–Lambert along each
chord), a little more where the leaf itself faces the sun, then stepped through
a palette from deep blue-green inside the canopy to yellow-green on the
sunniest tops. The clumps read as shapes. A leaf's own facing counts for little,
for the same sorting: when it made neighbours differ by two and a half times in
brightness, every swap flashed; close in colour, a swap doesn't show.

How it got here: smooth painted shading over big leaves read as a blob; leaves
turned to face you read as blur; small splats measured off the trees in
[`wind/`](../wind)'s capture read as patches. Each try was rendered offline
with a small CPU splat renderer that matches radix's crisp-edge falloff, at the
same scale as the view, before going on the GPU.

The bark is splats lying along the branches, dim under the canopy, nearly all of
them on the wood you can see: a branch inside a clump gets next to none.

## Wind

Gusts are patches of stronger wind rolling through downwind. The tree leans
with them and sways on its own slow rhythm, more towards its top (a
cantilever's bend), so the wood and the leaves move together; and the canopy
churns, on a smooth field over space (a broad layer the size of a mass, a finer
one the size of a clump), so neighbouring leaves always move together. Tried
first: each clump swinging on its own slid clumps through each other, and where
a sunlit one passed through a shaded one the leaves kept swapping which was in
front, flickering their colours. And leaves don't flutter one by one: tried, it
was busy; the movement that reads is the tree's.

## On the GPU

Where every splat sits and its light is worked out once, in a compute kernel;
each frame only adds the wind. On the WebGL2 backend there's no compute, so every splat
works itself out every frame from the same code.

[radix]: https://github.com/asundqui/radix-test
