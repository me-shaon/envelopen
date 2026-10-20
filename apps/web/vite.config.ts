import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The root package.json holds the Envelopen version. The Settings page shows it.
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __ENVELOPEN_VERSION__: JSON.stringify(rootPackage.version) },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
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
