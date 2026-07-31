import { defineConfig } from "vite";
import { resolve } from "node:path";

// Vite serves the project root, so legacy entry points (loop.html, va.html)
// remain reachable during the migration. Drop static media in `public/` to
// have it served from the root URL.
export default defineConfig({
  root: ".",
  resolve: {
    // Runtime half of the vendored @amplib packages; the type half is in
    // tsconfig.json's `paths`. The two must name the same files — a mismatch
    // typechecks clean and then fails at build, which is the worst order to
    // find out in.
    //
    // Both disappear once public-library publishes to npm. The specifiers below
    // are already the published names, so that swap is deletion, not a rewrite.
    alias: {
      "@amplib/sound-synthesis": resolve(
        __dirname,
        "vendor/amplib-sound-synthesis/index.js",
      ),
      "@amplib/hue-wheel": resolve(
        __dirname,
        "vendor/amplib-hue-wheel/index.js",
      ),
      "@amplib/music-theory": resolve(
        __dirname,
        "vendor/amplib-music-theory/index.js",
      ),
    },
  },
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
