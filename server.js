const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT || 8080);
const remoteSite = "https://aesthetic-biscochitos-eb1e34.netlify.app/";
const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
};

const server = http.createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
        response.writeHead(400).end("Bad request");
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

        response.setHeader("Content-Type", contentTypes[path.extname(filePath)] || "application/octet-stream");
        if (request.method === "HEAD") {
            response.writeHead(200).end();
            return;
        }
        fs.createReadStream(filePath).pipe(response);
    });
});

server.listen(port, "0.0.0.0", () => {
    console.log(`Gust server listening on http://0.0.0.0:${port}`);
});
