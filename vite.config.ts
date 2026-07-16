import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// All dependencies are bundled locally by Vite at build time.
// Do not add CDN <script> tags (e.g. jsdelivr, unpkg) to index.html —
// several of our users hit those on the corporate network via Edge.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
