import { copyFile } from "node:fs/promises";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    viteSingleFile(),
    {
      name: "myco-viewer-html",
      async writeBundle({ dir }) {
        if (dir) await copyFile(`${dir}/index.html`, `${dir}/myco-viewer.html`);
      },
    },
  ],
});
