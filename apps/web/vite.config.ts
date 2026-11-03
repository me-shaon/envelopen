import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// apps/worker/src/version.ts holds the Envelopen version. The app footer shows it.
const version = /^export const ENVELOPEN_VERSION = "([^"]+)";$/m.exec(
  readFileSync(new URL("../worker/src/version.ts", import.meta.url), "utf8"),
)?.[1];
if (!version) throw new Error("apps/worker/src/version.ts has no ENVELOPEN_VERSION line.");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __ENVELOPEN_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: [
      { find: "@", replacement: new URL("./src", import.meta.url).pathname },
      // The drag handle's collaboration imports, without Yjs (see no-collaboration.ts).
      {
        find: /^@tiptap\/(y-tiptap|extension-collaboration)$/,
        replacement: new URL("./src/features/editor/no-collaboration.ts", import.meta.url).pathname,
      },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // React and the libraries change less often than the app, so they get their
        // own cached chunks. These chunks hold only what the first page needs: the
        // editor libraries (Tiptap, React Email, and its server renderer) stay in the
        // chunks of the lazy editor route.
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              tags: ["$initial"],
              priority: 2,
            },
            { name: "vendor", test: /node_modules[\\/]/, tags: ["$initial"], priority: 1 },
          ],
        },
      },
    },
  },
});
