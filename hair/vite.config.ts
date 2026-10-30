import { defineConfig } from 'vite';

export default defineConfig({
    base: process.env.BASE_PATH ?? '/',
    // Keep radix and the app on one copy of three.
    resolve: { dedupe: ['three'] },
    // WebGPURenderer's backend is chosen with top-level await.
    build: { target: 'es2022' },
});
