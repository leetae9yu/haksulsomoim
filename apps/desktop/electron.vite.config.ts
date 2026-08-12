import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import packageJson from "./package.json";

const productionDependencies = Object.keys(packageJson.dependencies);
const externalMainDependency = (id: string): boolean =>
  id === "electron" ||
  productionDependencies.some((dependency) => id === dependency || id.startsWith(`${dependency}/`));

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: externalMainDependency,
        ...(mode === "qa" ? { input: { qa: resolve("src/main/qa.ts") } } : {}),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ["electron"],
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
}));
