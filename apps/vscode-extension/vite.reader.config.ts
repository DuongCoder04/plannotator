import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The Guide tab: Plannotator's guide reader (packages/guide-viewer over
 * review-editor's AllFilesCodeView, the same chain guides.show and the review
 * app render) in a VS Code webview. A multi-file build like guides.show's:
 * `reader.js` / `reader.css` are what the webview loads by name; Shiki's
 * grammars and themes are lazy chunks, the highlight worker is its own file
 * (fetched and started as a blob worker, see apps/guides-show/viewer/portablePool.tsx).
 * `base: './'` keeps chunk URLs relative to the entry, so they resolve under
 * the webview's resource origin.
 */
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Pierre runs Shiki's JavaScript regex engine: the Oniguruma WASM is dead weight.
      "shiki/wasm": path.resolve(__dirname, "../../build/shiki-wasm-stub.ts"),
      "katex/dist/katex.min.css": path.resolve(__dirname, "../guides-show/viewer/stubs/empty.css"),
    },
  },
  worker: {
    format: "es",
    rollupOptions: { output: { inlineDynamicImports: true, entryFileNames: "worker.[hash].js" } },
  },
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    target: "es2022",
    outDir: path.resolve(__dirname, "dist/reader"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4_000,
    sourcemap: false,
    rollupOptions: {
      input: { reader: path.resolve(__dirname, "src/guides/reader/main.tsx") },
      output: {
        inlineDynamicImports: false,
        entryFileNames: "reader.js",
        chunkFileNames: "chunks/[name].[hash].js",
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? info.name ?? "asset";
          if (name.endsWith(".css")) return "reader.css";
          if (/\.(woff2?|ttf|otf)$/.test(name)) return "fonts/[name].[hash][extname]";
          return "assets/[name].[hash][extname]";
        },
      },
    },
  },
});
