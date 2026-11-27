import { defineConfig } from "vite";
export default defineConfig({
  server: {
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.STUDY_BRIDGE_URL ?? "http://127.0.0.1:4318",
        changeOrigin: true,
        // Answer a relay that is down or restarting the way scripts/serve.mjs
        // does, so the client resends cut-off work instead of treating Vite's
        // empty 500 as a refusal. Vite's own handler skips once headers are sent.
        configure: (proxy) =>
          proxy.on("error", (_error, _req, res) => {
            if (!("writeHead" in res) || res.writableEnded) return;
            if (res.headersSent) return void res.destroy();
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error:
                  "Study bridge unavailable; it is restarting. Retry in a moment.",
              }),
            );
          }),
      },
    },
  },
  build: {
    rollupOptions: {
      input: { main: "index.html" },
      output: {
        // Cache dependencies separately from frequently changed app code.
        manualChunks: (id) =>
          id.includes("/node_modules/") ? "vendor" : undefined,
      },
    },
  },
});
