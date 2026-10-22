# fireworks

A fireworks show, and nothing in it was captured or simulated: shells climbing,
bursting and falling over a line of dark hills under a starry night, every spark
a splat worked out from the time.

Drawn by [spark-radix][radix] on three.js's `WebGPURenderer`. Drag to orbit,
right-drag or shift-drag to pan, scroll to move in.

## The show

Nine launch slots, each firing on its own period (six to eleven seconds) from
its own offset, so shells come singly, in pairs, after gaps and in the odd
volley; and a slot skips a turn about one time in four. Few enough that each
burst has room to land: fourteen was busy. Each turn of
a slot is a shell, every choice hashed from the slot and the turn: what kind,
which colours, where along the field it goes up from, how high it bursts, how
big it is.

Eight kinds:

- **peony**: a sphere of stars of one colour, a quarter of them an inner core of
  a second, flying out slower;
- **colour change**: a peony whose stars turn to a second colour halfway;
- **chrysanthemum**: gold or silver, with long trails, crackling as it dies;
- **willow**: gold, slow and heavy, its stars drooping and hanging for five
  seconds, cooling to embers;
- **ring**: a flat ring, tilted its own way;
- **palm**: a few thick gold comets with long trails, flung upwards like fronds;
- **crossette**: two dozen stars that each split into four on the way out, white
  hot again as they split;
- **strobe**: silver stars blinking on and off, each in its own time.

## A shell

- **The rocket**: a white-gold comet on a slowing climb, stretched along it, its
  tail two dozen samples laid on the path behind it, each stretched along the
  path, shrinking and cooling to a dim red, so the tail is one smooth tapering
  streak; and a few sparks of glitter, each shed again and again from wherever
  the comet then is, drifting down and flickering out. Out of sight behind the
  hills until it's past them. (A head and a spray of loose dots behind it read
  as a dotted line.)
- **The flash** where it bursts.
- **The stars**, spread evenly over a sphere (a spiral turned its own way per
  shell) or round the ring. Each flies out under drag and gravity in closed
  form: its velocity eases exponentially from its launch to the wind plus a
  terminal fall, so where it is at any time is one formula (a crossette's child
  flies on the same way from where its parent split). White hot as it bursts,
  then its colour, deepening and reddening as it cools towards the end and
  sputtering a little as it goes out; each star a little brighter or dimmer
  than the next; stretched along its motion the faster it goes. Crisp: opacity past 1 with `lodInflate` off, which radix draws as a
  hard-edged dot about four standard deviations out, softening only as it dies;
  soft Gaussian stars read as blur. Each star is drawn as a few samples back along its path,
  smaller and dimmer, so it leaves a trail.
- **Smoke**, left behind along the stars' paths: each puff is dropped somewhere
  along one star's flight, then grows, rises and drifts on the wind from there.
  So smoke trails stretch out behind the stars as they fly, and the burst's
  shape (a shell, a ring, a palm's fronds) hangs in smoke after they've burnt
  out, blurring as it drifts. A pale blue-grey just above the night's so it
  shows, glowing in its shell's colour while the stars burn, gone before its
  slot fires again. (One round cloud at the burst read as a blob.)

The colours are what burns them: strontium red, calcium orange, barium green,
copper blue (always the weakest and deepest), a violet of the two, magnesium
white, sodium gold (warm, not yellow) and silver. Evenly saturated computer
colours looked cheap.

The night is lit by the show: each burst lifts the whole sky a touch in its
colour and glows round itself, a flash then a lower glow while its stars burn,
and catches the crest of the hills. The sky shader works the shells out from the
clock the same way the splats do (one function both ask), so the glow is always
where the burst is.

The stars burn only a little past white, and a faint bloom takes only what's
past that, so the sparks glint and the night stays black. (Burning them far past
white, even a gentle bloom whited the sky out.)

## Stateless

Nothing is stored and nothing steps: like the falling leaves in
[`avatars/`](../avatars), every splat is a function of its index and the clock,
the same on WebGPU and the WebGL2 backend. About 23,000 splats.

[radix]: https://github.com/asundqui/radix-test
