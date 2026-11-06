import { defineConfig } from 'vite';

// Relative asset paths let one build load from GitHub Pages' project path
// (/chalkline/) and from the root of a server on a local network.
export default defineConfig({
  base: './',
});
