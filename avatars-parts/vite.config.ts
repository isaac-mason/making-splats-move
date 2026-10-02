import { defineConfig } from 'vite';

// Local dev serves from '/'. The GitHub Pages workflow sets BASE_PATH to
// '/<repo>/' so the app — and its absolute asset URLs (via import.meta.env.BASE_URL
// in src/scene.ts) — resolve correctly under the project subpath.
export default defineConfig({
    base: process.env.BASE_PATH ?? '/',
});
