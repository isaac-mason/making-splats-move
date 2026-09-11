import { defineConfig } from 'vite';

// Local dev serves from '/'. A Pages-style deploy can set BASE_PATH to '/<repo>/'
// so the app — and its absolute asset URLs (via import.meta.env.BASE_URL in
// src/scene.ts) — resolve correctly under a project subpath.
export default defineConfig({
    base: process.env.BASE_PATH ?? '/',
});
