import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(currentDirectory, "public");

const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/sw.js", { file: "sw.js", type: "text/javascript; charset=utf-8" }],
  ["/manifest.webmanifest", { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" }],
  ["/vendor/gsap.min.js", { file: "vendor/gsap.min.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/dokkaebi-ring.mp3", { file: "assets/dokkaebi-ring.mp3", type: "audio/mpeg" }],
  ["/assets/dokkaebi-overlay.mp3", { file: "assets/dokkaebi-overlay.mp3", type: "audio/mpeg" }],
  ["/assets/dokkaebi-icon.png", { file: "assets/dokkaebi-icon.png", type: "image/png" }],
  ["/assets/dokkaebi-icon-alert.png", { file: "assets/dokkaebi-icon-alert.png", type: "image/png" }],
  ["/assets/icon-192.png", { file: "assets/icon-192.png", type: "image/png" }],
  ["/assets/icon-512.png", { file: "assets/icon-512.png", type: "image/png" }],
  ["/assets/apple-touch-icon.png", { file: "assets/apple-touch-icon.png", type: "image/png" }],
]);

function writeJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function writeEvent(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendStaticFile(request, response, asset, contents) {
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; media-src 'self' blob:; script-src 'self'; style-src 'self'; worker-src 'self'",
    "Content-Type": asset.type,
    "X-Content-Type-Options": "nosniff",
  };

  const range = request.headers.range;
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);

  if (match) {
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : contents.length - 1;
    const end = Math.min(requestedEnd, contents.length - 1);

    if (start > end || start >= contents.length) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${contents.length}` });
      response.end();
      return;
    }

    const chunk = contents.subarray(start, end + 1);
    response.writeHead(206, {
      ...headers,
      "Content-Length": chunk.length,
      "Content-Range": `bytes ${start}-${end}/${contents.length}`,
    });
    response.end(request.method === "HEAD" ? undefined : chunk);
    return;
  }

  response.writeHead(200, { ...headers, "Content-Length": contents.length });
  response.end(request.method === "HEAD" ? undefined : contents);
}

export function createWibrateServer() {
  const clients = new Set();

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      clients.add(response);
      writeEvent(response, "ready", { connected: true });

      request.on("close", () => {
        clients.delete(response);
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/wibrate") {
      const event = {
        id: randomUUID(),
        senderId: request.headers["x-logic-bomb-client"] ?? null,
        sentAt: Date.now(),
      };

      for (const client of clients) {
        writeEvent(client, "wibrate", event);
      }

      writeJson(response, 202, { ok: true, ...event });
      return;
    }

    const asset = request.method === "GET" || request.method === "HEAD" ? staticFiles.get(url.pathname) : null;
    if (asset) {
      try {
        const contents = await readFile(join(publicDirectory, asset.file));
        sendStaticFile(request, response, asset, contents);
      } catch (error) {
        console.error(error);
        writeJson(response, 500, { error: "Unable to load the page" });
      }
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  });
}

function listLanAddresses(port) {
  const addresses = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const details of interfaces ?? []) {
      if (details.family === "IPv4" && !details.internal) {
        addresses.push(`http://${details.address}:${port}`);
      }
    }
  }
  return addresses;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const requestedPort = Number.parseInt(process.argv[2] ?? "4173", 10);
  const port = Number.isInteger(requestedPort) ? requestedPort : 4173;
  const server = createWibrateServer();

  server.listen(port, "0.0.0.0", () => {
    console.log("\nLOGIC BOMB is running:");
    console.log(`  This computer: http://localhost:${port}`);
    for (const address of listLanAddresses(port)) {
      console.log(`  Local network: ${address}`);
    }
    console.log("\nOpen the local-network address on every phone. Press Ctrl+C to stop.\n");
  });
}
