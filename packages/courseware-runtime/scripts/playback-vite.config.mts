import { defineConfig } from "vitest/config";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = process.env.D_BUILD_DIRECTORY;
if (!buildDirectory || !path.isAbsolute(buildDirectory))
  throw new Error("D_BUILD_DIRECTORY must name a fixed build directory");
export default defineConfig({
  root,
  publicDir: path.join(root, "assets"),
  cacheDir: path.join(root, ".cache/desktop-playback-vite"),
  define: { "process.env": "{}" },
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": root } },
  plugins: [
    {
      name: "fixed-local-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = req.url?.split("?")[0];
          if (url === "/fixture.json") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ buildId: path.basename(buildDirectory) }));
            return;
          }
          if (!url?.startsWith("/build/")) return next();
          const file = url.slice("/build/".length);
          if (
            file !== "package.json" &&
            !/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(file)
          ) {
            res.statusCode = 404;
            res.end();
            return;
          }
          try {
            const bytes = await readFile(path.join(buildDirectory, file));
            res.setHeader(
              "Content-Type",
              file.endsWith(".json")
                ? "application/json"
                : file.endsWith(".mp4")
                  ? "video/mp4"
                  : file.endsWith(".wav")
                    ? "audio/wav"
                    : file.endsWith(".png")
                      ? "image/png"
                      : "application/octet-stream",
            );
            res.end(bytes);
          } catch {
            res.statusCode = 404;
            res.end();
          }
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 4259,
    strictPort: true,
    fs: { allow: [root] },
  },
});
