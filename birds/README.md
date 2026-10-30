# birds

A murmuration at dusk: eight thousand starlings wheeling overhead, each simulated on the GPU and drawn as a little bird of seven splats. Drawn by [Radix][radix] on three.js's `WebGPURenderer`.

```bash
pnpm --filter birds dev
```

Your cursor is a hawk: the birds part around it, and a fast swipe scatters them in a wave of fright. Drag to orbit, right-drag or shift-drag to pan, scroll to move in; let go and the view eases back to looking up. Every thirteen seconds a falcon dives through.

On the WebGL2 backend (`?gpu=webgpu-gl`) there is no compute, so the flock churns statelessly instead of flying.

[radix]: https://sparkjs.dev/radix/
