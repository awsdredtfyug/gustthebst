const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const root = __dirname;
const port = Number(process.env.PORT || 8080);
const remoteSite = "https://aesthetic-biscochitos-eb1e34.netlify.app/";
const configPath = path.join(root, "site-config.json");
const adminPassword = process.env.GUST_ADMIN_PASSWORD || "";
const adminSessions = new Map();
const loginAttempts = new Map();
const sessionLifetime = 12 * 60 * 60 * 1000;
const allowedSearchEngines = new Set([
    "https://duckduckgo.com/?q=",
    "https://search.brave.com/search?q=",
    "https://www.bing.com/search?q=",
    "https://search.yahoo.com/search?p=",
]);
const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
};

function defaultConfig() {
    return {
        settings: {
            siteName: "Gust",
            defaultWisp: "wss://admin.proxy.hydrovolter.com/scramjet/wisp/",
            wispAutoswitch: true,
            searchEngine: "https://duckduckgo.com/?q=",
        },
        members: {
            simulated: true,
            startCount: 483,
            targetCount: 1000,
            cycleHours: 2,
        },
        games: [],
    };
}

function normalizeConfig(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Configuration must be an object.");
    }

    const settings = input.settings || {};
    const members = input.members || {};
    const siteName = typeof settings.siteName === "string" ? settings.siteName.trim() : "";
    const defaultWisp = typeof settings.defaultWisp === "string" ? settings.defaultWisp.trim() : "";
    let wispUrl;
    try { wispUrl = new URL(defaultWisp); } catch { throw new Error("Default Wisp URL is invalid."); }
    if (!["ws:", "wss:"].includes(wispUrl.protocol)) throw new Error("Default Wisp URL must use ws:// or wss://.");
    if (!allowedSearchEngines.has(settings.searchEngine)) throw new Error("Choose a supported search engine.");

    const startCount = Number(members.startCount);
    const targetCount = Number(members.targetCount);
    const cycleHours = Number(members.cycleHours);
    if (!Number.isInteger(startCount) || startCount < 0 || startCount > 100000) {
        throw new Error("Starting member count must be an integer from 0 to 100,000.");
    }
    if (!Number.isInteger(targetCount) || targetCount < startCount || targetCount > 100000) {
        throw new Error("Target count must be an integer at least as large as the start count.");
    }
    if (!Number.isFinite(cycleHours) || cycleHours < 0.25 || cycleHours > 168) {
        throw new Error("Cycle duration must be between 0.25 and 168 hours.");
    }
    if (!Array.isArray(input.games) || input.games.length > 40) {
        throw new Error("Add no more than 40 game links.");
    }

    const games = input.games.map((game) => {
        const name = typeof game?.name === "string" ? game.name.trim().slice(0, 40) : "";
        let url;
        try { url = new URL(game?.url); } catch { throw new Error(`Enter a valid URL for ${name || "each game"}.`); }
        if (!name || !["https:", "http:"].includes(url.protocol)) {
            throw new Error("Each game needs a name and an HTTP(S) URL.");
        }
        return { id: String(game.id || crypto.randomUUID()).slice(0, 64), name, url: url.href };
    });

    return {
        settings: {
            siteName: siteName.slice(0, 40) || "Gust",
            defaultWisp: wispUrl.href,
            wispAutoswitch: settings.wispAutoswitch === true,
            searchEngine: settings.searchEngine,
        },
        members: { simulated: true, startCount, targetCount, cycleHours },
        games,
    };
}

let cachedConfig;
async function getConfig() {
    if (cachedConfig) return cachedConfig;
    try {
        const text = await fs.promises.readFile(configPath, "utf8");
        cachedConfig = normalizeConfig(JSON.parse(text));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        cachedConfig = defaultConfig();
        await saveConfig(cachedConfig);
    }
    return cachedConfig;
}

async function saveConfig(config) {
    const normalized = normalizeConfig(config);
    const temporaryPath = `${configPath}.tmp`;
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporaryPath, configPath);
    cachedConfig = normalized;
    return normalized;
}

function sendJson(response, status, body, headers = {}) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers,
    });
    response.end(JSON.stringify(body));
}

function readJsonBody(request, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error("Request body is too large."));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
            catch { reject(new Error("Request body must be valid JSON.")); }
        });
        request.on("error", reject);
    });
}

function getSessionToken(request) {
    const cookie = request.headers.cookie || "";
    const match = cookie.match(/(?:^|;\s*)gust_admin=([a-f0-9]+)/);
    return match?.[1] || "";
}

function hasAdminSession(request) {
    const token = getSessionToken(request);
    const expiresAt = adminSessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
        adminSessions.delete(token);
        return false;
    }
    return true;
}

async function handleApi(request, response, pathname) {
    if (pathname === "/api/public-config" && request.method === "GET") {
        try { sendJson(response, 200, await getConfig()); }
        catch (error) {
            console.error("Public config load failed:", error);
            sendJson(response, 500, { error: "Could not load site configuration." });
        }
        return;
    }

    if (pathname === "/api/admin/status" && request.method === "GET") {
        sendJson(response, 200, { configured: Boolean(adminPassword), authenticated: hasAdminSession(request) });
        return;
    }

    if (pathname === "/api/admin/login" && request.method === "POST") {
        if (!adminPassword) {
            sendJson(response, 503, { error: "Admin access is disabled. Set GUST_ADMIN_PASSWORD and restart the server." });
            return;
        }
        const ip = request.socket.remoteAddress || "unknown";
        const attempts = (loginAttempts.get(ip) || []).filter((time) => Date.now() - time < 15 * 60 * 1000);
        if (attempts.length >= 8) {
            sendJson(response, 429, { error: "Too many login attempts. Try again in 15 minutes." });
            return;
        }
        try {
            const { password } = await readJsonBody(request);
            const supplied = Buffer.from(typeof password === "string" ? password : "");
            const expected = Buffer.from(adminPassword);
            const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
            if (!valid) {
                attempts.push(Date.now());
                loginAttempts.set(ip, attempts);
                sendJson(response, 401, { error: "Incorrect password." });
                return;
            }

            loginAttempts.delete(ip);
            const token = crypto.randomBytes(32).toString("hex");
            adminSessions.set(token, Date.now() + sessionLifetime);
            sendJson(response, 200, { authenticated: true }, {
                "Set-Cookie": `gust_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}`,
            });
        } catch (error) {
            sendJson(response, 400, { error: error.message });
        }
        return;
    }

    if (pathname === "/api/admin/logout" && request.method === "POST") {
        adminSessions.delete(getSessionToken(request));
        sendJson(response, 200, { authenticated: false }, {
            "Set-Cookie": "gust_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
        });
        return;
    }

    if (pathname === "/api/admin/config" && ["GET", "PUT"].includes(request.method)) {
        if (!hasAdminSession(request)) {
            sendJson(response, 401, { error: "Admin login required." });
            return;
        }
        try {
            if (request.method === "GET") {
                sendJson(response, 200, await getConfig());
                return;
            }
            const input = await readJsonBody(request);
            sendJson(response, 200, await saveConfig(input));
        } catch (error) {
            sendJson(response, 400, { error: error.message || "Could not save configuration." });
        }
        return;
    }

    sendJson(response, 404, { error: "API route not found." });
}

const server = http.createServer(async (request, response) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
        response.writeHead(400).end("Bad request");
        return;
    }

    if (pathname.startsWith("/api/")) {
        await handleApi(request, response, pathname);
        return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
        return;
    }

    if (pathname === "/download-netlify-html") {
        try {
            const remoteResponse = await fetch(remoteSite, { signal: AbortSignal.timeout(15000) });
            if (!remoteResponse.ok) throw new Error(`Remote site returned ${remoteResponse.status}`);

            let html = await remoteResponse.text();
            const baseHref = new URL(".", remoteResponse.url).href;
            html = html.replace(/<head(\b[^>]*)>/i, `$&\n<base href="${baseHref}">`);

            response.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Disposition": 'attachment; filename="the-wagon-site.html"',
                "Cache-Control": "no-store",
            });
            response.end(request.method === "HEAD" ? undefined : html);
        } catch (error) {
            console.error("Remote HTML download failed:", error);
            response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Could not fetch the Netlify website HTML.");
        }
        return;
    }

    const relativePath = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.resolve(root, `.${relativePath}`);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        response.writeHead(403).end("Forbidden");
        return;
    }

    fs.stat(filePath, (error, stats) => {
        if (error || !stats.isFile()) {
            response.writeHead(404).end("Not found");
            return;
        }

        const contentType = contentTypes[path.extname(filePath)] || "application/octet-stream";
        response.setHeader("Content-Type", contentType);
        response.setHeader("Cache-Control", pathname.startsWith("/vendor/") ? "public, max-age=604800" : "no-cache");
        if (request.method === "HEAD") {
            response.writeHead(200).end();
            return;
        }

        const acceptEncoding = request.headers["accept-encoding"] || "";
        const isCompressible = /^(text\/|application\/(?:javascript|json|wasm)|image\/svg\+xml)/i.test(contentType);
        if (stats.size >= 1024 && isCompressible && /\bbr\b/.test(acceptEncoding)) {
            response.setHeader("Vary", "Accept-Encoding");
            response.setHeader("Content-Encoding", "br");
            fs.createReadStream(filePath)
                .pipe(zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }))
                .pipe(response);
            return;
        }
        if (stats.size >= 1024 && isCompressible && /\bgzip\b/.test(acceptEncoding)) {
            response.setHeader("Vary", "Accept-Encoding");
            response.setHeader("Content-Encoding", "gzip");
            fs.createReadStream(filePath).pipe(zlib.createGzip({ level: 6 })).pipe(response);
            return;
        }
        fs.createReadStream(filePath).pipe(response);
    });
});

server.listen(port, "0.0.0.0", () => {
    console.log(`Gust server listening on http://0.0.0.0:${port}`);
});
