import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dreamFixture } from "./dream-fixture.ts";

const directory = fileURLToPath(new URL("../artifacts/dream-demo/", import.meta.url));
const port = Number(process.env.PORT ?? 4174);
const files: Record<string, { name: string; type: string }> = {
  "/result": { name: "index.html", type: "text/html; charset=utf-8" },
  "/before.png": { name: "before.png", type: "image/png" },
  "/selected.png": { name: "selected.png", type: "image/png" },
  "/goal.png": { name: "goal.png", type: "image/png" },
};
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(dreamFixture); return; }
  const file = files[path];
  if (!file) { response.writeHead(404); response.end("Not found"); return; }
  try {
    const data = await readFile(join(directory, file.name));
    response.writeHead(200, { "Content-Type": file.type, "Cache-Control": "no-store" }); response.end(data);
  } catch { response.writeHead(404); response.end("Run npm run dream:record to create the demo screenshots first."); }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Dream playground: http://127.0.0.1:${port}\nIn Pi: /dream http://127.0.0.1:${port}\nRecorded screenshot gallery: http://127.0.0.1:${port}/result`);
});
