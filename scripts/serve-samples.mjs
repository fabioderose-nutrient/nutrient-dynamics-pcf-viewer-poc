// Serves the files of samples/ with CORS headers, so the control can open them from the
// PCF test harness: paste http://localhost:8182/data-handling-policy.pdf into documentUrl.
// Run with: npm run samples

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "samples");
const port = Number(process.env.SAMPLES_PORT) || 8182;

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // only plain file names, no sub-folders, so nothing outside samples/ can be read
  const name = basename(decodeURIComponent(new URL(req.url, "http://localhost").pathname));
  try {
    const body = await readFile(join(root, name));
    res.writeHead(200, { "Content-Type": name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}).listen(port, () => console.log(`Samples on http://localhost:${port}/data-handling-policy.pdf`));
