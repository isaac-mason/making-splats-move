import { defineConfig } from 'vite';

export default defineConfig({
    base: process.env.BASE_PATH ?? '/',
    // spark-radix is built from its own checkout, with its own three. Two copies
    // of three means two renderers' worth of node registries, so force everything
    // onto this app's.
    resolve: { dedupe: ['three'] },
    // WebGPURenderer's backend is chosen with top-level await.
    build: { target: 'es2022' },
});
