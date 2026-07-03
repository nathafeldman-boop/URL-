/**
 * Verdict — serveur local de développement (zéro dépendance).
 * Sert le front statique de public/ et expose POST /api/analyze.
 * En production Vercel, ce rôle est tenu par api/analyze.js + le CDN statique.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

loadDotEnv();

const { analyze, compare } = require("./lib/audit");
const { createCheckout } = require("./lib/checkout");
const { activate } = require("./lib/activate");
const { checkAnalyze, checkCompare, FREE_LIMIT } = require("./lib/access");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && (req.url === "/api/analyze" || req.url === "/api/compare" || req.url === "/api/activate")) {
      let payload;
      try {
        payload = JSON.parse(await readBody(req, 256 * 1024));
      } catch {
        return sendJson(res, 400, { error: "Corps de requête invalide." });
      }

      if (req.url === "/api/activate") {
        const { status, body } = await activate(payload);
        return sendJson(res, status, body);
      }

      if (req.url === "/api/compare") {
        const access = checkCompare(req);
        if (!access.allowed) return sendJson(res, access.error.status, access.error.body);
        const { status, body } = await compare(payload.url, payload.competitor);
        return sendJson(res, status, body);
      }

      const access = checkAnalyze(req);
      if (!access.allowed) return sendJson(res, access.error.status, access.error.body);
      const { status, body } = await analyze(payload.url);
      if (status === 200 && !access.pro) {
        res.setHeader("Set-Cookie", access.consume());
        body.quota_restant = FREE_LIMIT - access.used - 1;
      }
      return sendJson(res, status, body);
    }
    if (req.method === "GET" && req.url.split("?")[0] === "/api/checkout") {
      const plan = new URL(req.url, "http://x").searchParams.get("plan") || "mensuel";
      const { status, redirectUrl, body } = await createCheckout(`http://localhost:${PORT}`, plan);
      if (redirectUrl) {
        res.writeHead(status, { Location: redirectUrl });
        return res.end();
      }
      return sendJson(res, status, body);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return serveStatic(req, res);
    }
    sendJson(res, 405, { error: "Méthode non autorisée." });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: "Erreur interne. Réessaie dans un instant." });
  }
});

server.listen(PORT, () => {
  console.log(`Verdict en ligne → http://localhost:${PORT}`);
  if (!process.env.MISTRAL_API_KEY) {
    console.warn("⚠ MISTRAL_API_KEY manquante — l'analyse renverra une erreur. Copie .env.example vers .env.");
  }
});

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let filePath = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Interdit." });
  // Équivalent local du cleanUrls de Vercel : /app → app.html
  if (!fs.existsSync(filePath) && fs.existsSync(filePath + ".html")) filePath += ".html";
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) return reject(new Error("Payload trop grand."));
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
