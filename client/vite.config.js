import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/socket.io": { target: "http://localhost:4000", ws: true },
      "/puzzle": "http://localhost:4000",
      "/stats": "http://localhost:4000",
      "/health": "http://localhost:4000",
      "/analytics": "http://localhost:4000",
    }
  }
});
