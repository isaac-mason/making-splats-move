# wind

Trees swaying in a Gaussian-splat city street. The splat file is untouched; foliage moves because each splat's centre is displaced on the GPU every frame by a TSL modifier. Drawn by [Radix](https://sparkjs.dev/radix/) on three.js's `WebGPURenderer` (`?gpu=webgpu-gl` forces the WebGL2 backend).

```bash
pnpm --filter wind dev
```

Press **backtick** for the debug panel and tick **wind edit mode** to place the sway volumes with a gizmo and see which splats they claim. The result copies out as JSON in the shape of [`src/wind.json`](src/wind.json).

## Assets

The scene came from [Marble](https://marble.worldlabs.ai/) (World Labs' 3D-world
generator), exported as a `.spz` splat.
