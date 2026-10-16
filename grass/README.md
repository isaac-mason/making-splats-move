# grass

Rolling hills of long grass on a summer afternoon, and nothing in it was captured.
The hills and every blade of grass are splats generated on the GPU from their
index and the time, so the wind costs nothing extra: each frame makes every blade
afresh, already bent. Cloud shadows sweep across the hills.

Drawn by [spark-radix][radix] on three.js's `WebGPURenderer`. **WASD** to walk,
**shift** to run, drag to look round, scroll to come closer or stand back.

## A meadow without end

You're a little cartoon kid walking it in third person (see below). Everything in the meadow,
grass, ground, flowers and butterflies, lives in one 60 metre tile, and each thing
is drawn at whichever copy of its place is nearest you. So it holds still in the
world until you've gone far enough that it wraps round to the far side, out in
the haze ahead. That's all on the GPU, per splat, so it costs nothing to run as
far and as fast as you like. The hills, the flower drifts, the dry patches, the
wind and the clouds are all world-space fields, so the land itself never repeats;
only the scatter of blades does, 60 metres apart, where the haze hides it.

## You

A little cartoon kid in a sky-blue sundress and a wide straw sunhat with a red
ribbon, pigtails, red shoes, and a wicker basket of posies on one arm. A couple of
dozen parts, each a shell of splats over an ellipsoid (the basket's handle a
ring), hinged at hips, shoulders, neck and hand, and posed in the shader from a
stride clock, so the CPU only says how far you've gone, which way you face and how
fast.

Walking is a light bounce on alternating legs. Running is skipping: big and small
hops in turn, the leading knee up, the free arm swinging up, a squash on landing
and a stretch in the air. The hat bounces a beat late, the basket swings, the head
nods, and standing still, the kid breathes. Lit like a cartoon: banded sun, sky
fill and a rim.

## The dress and the hair, simulated

The skirt is cloth: 28 points round the waist and eight rows of them to the hem,
pinned at the waist and simulated in compute kernels every frame. A Verlet step
carries each point on under gravity, the meadow's wind and your own motion, so the
skirt lags and swings as you skip. Then eight rounds of distance constraints
between neighbours keep it fabric, a gentle pull towards a flared rest shape keeps
it a skirt rather than a heap, and it's pushed out of the legs and hips so it
drapes over them. It's drawn as two splats a cloth cell, each facing the way the
cloth does there, so folds catch the light; pleats and a white hem trim finish it.

The hair is the same idea in chains: 56 strands of seven points, a curtain at the
back under the hat brim and two pigtails from red ties, held at the root, swung by
gravity, wind and you, loosely holding their shape, and kept off the head and
shoulders. Each segment is a tapering splat.

All of it lives in world space, so inertia comes free: the pinned ends move with
you and the rest have to catch up. The kid's pose is a function rather than
values, so the kid's splats and both simulations each build their own copy of it
into their own shader. Without compute (WebGL2) the kid keeps a solid skirt and
pigtails.

## Trampling, on the GPU

The grass parts round you and stays flattened behind you, springing back over a
few seconds. That's a little simulation in a compute kernel: a 128 by 128 grid of
grass state round you, a quarter of a metre a cell, each cell holding which way
and how far its grass is pushed over. Each frame the kernel lets every cell spring
back, and pushes the cells you're in outward from you and along your stride. The
grid is addressed by world position and wraps like the meadow, and each cell
remembers which bit of world it holds, so it starts clean when it wraps round to
new ground. Blades and flowers read their cell. The CPU's only job is to say where
you are. With no compute (the WebGL2 backend) the grass simply doesn't trample.

## A blade

A blade is five splats strung along a curve from root to tip: long along the
blade, a narrow strip across it, paper thin. The curve is a quadratic Bézier whose
tip leans by the blade's own rest lean plus the wind, so it bends from the root and
curls most at the tip. Each blade is turned about its own length at random, so the
field catches the light at every angle.

The blades are scattered at random. Random on purpose: it clumps a little, as grass does, where any evenly
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
- **Flutter**: each stem shakes on its own, at its own rate, more in a gust, along
  the wind and a little across it. Not a wave running through the field: a shared
  wave moves every blade in step, and the eye reads that as the ground heaving
  rather than the grass blowing.
- **Scatter**: each stem leans a little its own way off the wind, so a gust
  doesn't lay the field over as one sheet.
- **Lulls and gusts**: how hard it blows rises and falls over tens of seconds, and
  that travels too: a lull rolls across the field with the wind rather than the
  whole field calming at once. The wind veers a little, and taller blades catch
  more of it.

Bent blades show more of their lighter face, so a gust reads as a brighter wave
rolling through the grass.

## Wildflowers

Poppies, cornflowers, oxeye daisies, buttercups and knapweed, in drifts: one noise
field says where flowers gather and another which kind leads each drift, with
strays of every kind in between.

What keeps them from looking like stickers:

- **Each kind has its own shape**: a poppy's four broad cupped petals, a daisy's
  domed yellow eye in a dense ring of rays bent slightly back, a buttercup's five small cups, a
  cornflower's ragged florets, a knapweed's upright tuft.
- **Muted colours**, and no two petals quite alike in size, angle or shade. Now and
  then one is missing.
- **Heads tipped every which way**, so from eye height most are seen side-on, not
  as flat rings facing the sky.
- **Buds**: some haven't opened, a green head going over to its colour.
- **Every height**, some down among the grass.

They share the grass's wind and stem curve, a little stiffer, so they bob in the
same gusts. Petals are separate shapes, so they're drawn crisp: opacity past 1 on
an object with radix's LoD inflation off, which radix draws as a harder edge. The
grass can't take that (a blade's splats stack into one, and hard rims show as
separate leaves), but a petal is one splat, and a crisp one reads as a petal.

## Butterflies

Cabbage whites, fritillaries, common blues and brimstones working the flowers in
front of you. Each goes from flower to flower: it rests on one, wings closed
upright and opening flat now and then to bask, swaying with the flower in the
wind; then takes off and flies an eased, curving path with a rise in the middle,
facing the way it's going, and lands on the next.

The flowers are the real ones. Where a flower grows, how tall it is, whether its
drift lets it show and how the wind has it bent are one function both share, so
a butterfly can look at a few flowers at random, take the nearest that shows, and
sit on its head. All without any state: which flower is visit `k`'s comes from
hashing the butterfly and `k`, and a visit is just where the clock is in it.

Each is a body, two antennae, and on each side a forewing (a broad inner part and
a pointed tip swept forward, marked per kind, like a cabbage white's black tips)
and a rounded hindwing. Wings beat four or five times a second (faster aliases
into a buzz at 60 frames a second), now and then gliding briefly. Seen from below
they show their duller underside. They're crisp, like the petals, and thin enough
to glow with the sun behind them.

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
| `src/field.ts` | The hills, the grass, the flowers, the butterflies, the wind, the clouds, the trampling and you, each with its tunables. |
| `src/index.ts` | Walking and the follow camera, the sky, the post pass and the loop. |

[radix]: https://github.com/asundqui/radix-test
