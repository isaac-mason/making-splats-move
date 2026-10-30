# reveal

A 96MB Gaussian-splat city that assembles itself from a single point when it finishes downloading: a wavefront ripples outward and surges splats into place. A TSL modifier on [spark-radix][radix]'s stored-splat generator; the city is shared with [`wind/`](../wind).

```bash
pnpm --filter reveal dev
```

- **backtick** opens the debug panel (camera coordinates, splat count, frame time, **replay**).
- `?t=1.2` freezes the wavefront at one moment.
- `?cam=x,y,z` and `?look=x,y,z` move the camera; `?origin=x,y,z` moves the ripple's origin.

[radix]: https://github.com/asundqui/radix-test
