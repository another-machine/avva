import { defineConfig } from "vite";
import { resolve } from "node:path";

// Vite serves the project root, so legacy entry points (loop.html, va.html)
// remain reachable during the migration. Drop static media in `public/` to
// have it served from the root URL.
export default defineConfig({
  root: ".",
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
