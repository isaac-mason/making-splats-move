import { defineConfig } from 'vite';

// Local dev serves from '/'. The GitHub Pages workflow sets BASE_PATH to
// '/<repo>/' so the app — and its absolute asset URLs (via import.meta.env.BASE_URL
// in src/scene.ts) — resolve correctly under the project subpath.
//
// publicDir points at wind/'s, because this example shows off the same 96MB city and
// a second copy of it in the repository would be 96MB of nothing.
export default defineConfig({
    base: process.env.BASE_PATH ?? '/',
    publicDir: '../wind/public',
});
