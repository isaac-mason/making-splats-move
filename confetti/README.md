# confetti

You hold the confetti gun: click, and a burst of confetti fires from it out
along where you clicked, flies off into the room, flutters down and piles up on
the floor. Nothing in it is captured or simulated: every piece of
paper is a splat worked out from the time.

Drawn by [spark-radix][radix] on three.js's `WebGPURenderer`. Click to fire;
drag to orbit, right-drag or shift-drag to pan, scroll to move in.

## The take

A clean, warm, pale studio, so the colours pop: the backdrop a soft gradient,
the floor the same warm white melting into it. One burst goes off as it opens;
after that it's yours.

## A piece of paper

A strip or a dot, crisp (opacity past 1 with `lodInflate` off, a hard-edged
ellipse), in classic confetti colours, about one in seven gold or silver foil.

Paper is all drag for its weight. So it's worked out in closed form like the
fireworks' stars, but its velocity eases fast (exponentially) from the shot to
a slow terminal fall, about a metre a second: a shot carries it a few metres,
then it drifts down. As it slows it sways from side to side, its own
way and pace, and it tumbles over and over about an axis of its own. It's lit
as a sheet from either side, brighter turned to the light, so it flashes light
and dark as it turns; foil glints when it catches the light towards you.

Where it reaches the floor comes from the same formula (once the shot has died
away, the fall is a straight line in time), so each piece stops dead where it
lands and lies flat, turned its own way, and the floor fills up with it.

## Bursts

A ring of sixteen slots, each two uniforms the CPU sets on a click: where it was
fired from and when, and which way. The gun's muzzle is held a little right of
and below your eye, aimed at where you clicked ten metres out, and fires a
tight cone at 9 to 22 m/s. (A cannon on the floor and a popper in the air came
first; it's better as yours to fire.) The seventeenth click reuses the
oldest; a burst's pieces lie on the floor for forty seconds, then fade. A click
is a press and release that barely moved, so dragging still orbits.

Sixteen bursts of 1,600 pieces: about 26,000 splats, the same on WebGPU and the
WebGL2 backend.

[radix]: https://github.com/asundqui/radix-test
