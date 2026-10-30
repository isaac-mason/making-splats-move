# confetti

You hold the confetti gun: click and a burst of splat paper fires out along where you clicked, flutters down and piles up on the floor. Nothing is captured or simulated; every piece is worked out from its index and the time.

```bash
pnpm --filter confetti dev
```

Click to fire; drag to orbit, right-drag or shift-drag to pan, scroll to move in. Drawn by [spark-radix][radix] on three.js's `WebGPURenderer` (`?gpu=webgpu-gl` for the WebGL2 backend).

[radix]: https://github.com/asundqui/radix-test
