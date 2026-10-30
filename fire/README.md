# fire

A campfire under a starry sky, drawn by [spark-radix][radix] on three.js's `WebGPURenderer`. The splat scene is static; the flame, smoke, embers, firelight and heat shimmer are generated at render time. On WebGPU the fire rides a small compute fluid simulation; without compute it falls back to stateless generators (`?sim=0` forces that).

```bash
pnpm --filter fire dev
```

- Click or tap to stoke the fire; move the cursor to lean the camera.
- **backtick** opens the debug panel: orbit camera, layer toggles, sliders, and click-to-raycast for measuring landmarks in `src/scene.ts`.
- `?record=1` renders a fixed-clock take to an MP4 and downloads it (`fps`, `width`, `height`, `mbps` change the format).

## Assets

The scene came from [Marble](https://marble.worldlabs.ai/) (World Labs' 3D-world
generator), exported as a `.spz` splat.

[radix]: https://github.com/asundqui/radix-test
