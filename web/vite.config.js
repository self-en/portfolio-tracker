import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  // Il proxy tiene tutto same-origin in sviluppo: il cookie di sessione è
  // httpOnly + SameSite=Lax, quindi con la SPA su :5173 e l'API su :3000 come
  // origini distinte non verrebbe mai inviato.
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
    },
  },
});
