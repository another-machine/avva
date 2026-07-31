import { defineConfig } from "vite";
import { resolve } from "node:path";

// Vite serves the project root, so legacy entry points (loop.html, va.html)
// remain reachable during the migration. Drop static media in `public/` to
// have it served from the root URL.
export default defineConfig({
  root: ".",
  // No @amplib aliases. Every one of them is a real npm dependency now and
  // resolves normally — the vendored bundles and the tsconfig `paths` that
  // typed them are gone. Not one import statement changed, which is what those
  // specifiers were chosen for.
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        controller: resolve(__dirname, "controller/index.html"),
      },
    },
  },
});
