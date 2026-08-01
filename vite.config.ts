import { defineConfig } from "vite";
import { resolve } from "node:path";

// Vite serves the project root, so legacy entry points (loop.html, va.html)
// remain reachable during the migration. Drop static media in `public/` to
// have it served from the root URL.
export default defineConfig({
  root: ".",
  // No @amplib aliases. Every one of them resolves as an ordinary dependency
  // from npm — the vendored bundles and the tsconfig `paths` that typed them are
  // gone, and so is the `file:` link @amplib/color used while it was held back.
  // That link resolved only on a machine with public-library checked out beside
  // this repo: npm symlinked it into node_modules and everything built locally,
  // while CI checked out avva alone and failed on three missing imports.
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
