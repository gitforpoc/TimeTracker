import { resolve } from "path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Note: @mpoc/auth is consumed as a local package via "file:../shared-auth"
// in package.json. Vite resolves it through node_modules naturally — no alias needed.
// See shared-auth/README.md and shared-docs/AUTH-UNIFICATION-PLAN.md.

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        admin: resolve(__dirname, "admin.html"),
        privacy: resolve(__dirname, "privacy.html"),
      },
    },
  },
  test: {
    environment: "node",
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        globPatterns: ["**/*.{js,css,html,png}"],
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: "TimeTracker",
        short_name: "TimeTracker",
        start_url: "/",
        display: "standalone",
        background_color: "#1c1c57",
        theme_color: "#1c1c57",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
    }),
  ],
});
