// Trusted package-download proxy. Untrusted containers have an internal network;
// this is their only temporary route out during installation/build.
import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
const hosts = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "storage.googleapis.com",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "services.gradle.org",
  "downloads.gradle.org",
  "plugins.gradle.org",
  "api.nuget.org",
  "globalcdn.nuget.org",
  "www.nuget.org",
  "rubygems.org",
  "index.rubygems.org",
  "packagist.org",
  "repo.packagist.org",
  "getcomposer.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];
function publicIp(ip) {
  const p = ip.split(".").map(Number);
  return (
    p.length === 4 &&
    p[0] > 0 &&
    p[0] < 224 &&
    ![10, 127].includes(p[0]) &&
    !(p[0] === 169 && p[1] === 254) &&
    !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) &&
    !(p[0] === 192 && p[1] === 168) &&
    !(p[0] === 100 && p[1] >= 64 && p[1] <= 127) &&
    !(p[0] === 198 && [18, 19].includes(p[1]))
  );
}
async function address(host) {
  if (!hosts.includes(host.toLowerCase()))
    throw new Error("Package host not allowed");
  const answers = await lookup(host, { all: true, family: 4 });
  const answer = answers.find((a) => publicIp(a.address));
  if (!answer) throw new Error("Non-public package address");
  return answer.address;
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url);
    if (
      url.protocol !== "http:" ||
      (url.port && url.port !== "80") ||
      !["GET", "HEAD", "POST"].includes(req.method)
    )
      throw new Error("Unsupported package request");
    const ip = await address(url.hostname);
    const upstream = http.request(
      {
        host: ip,
        port: 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: { ...req.headers, host: url.hostname },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.setTimeout(60000, () => upstream.destroy());
    upstream.on("error", () => {
      res.writeHead(502);
      res.end("Package proxy error");
    });
    req.pipe(upstream);
  } catch {
    res.writeHead(403);
    res.end("Package egress denied");
  }
});
server.on("connect", async (req, socket, head) => {
  try {
    const [host, port] = req.url.split(":");
    if (port !== "443") throw new Error("Only HTTPS packages");
    const ip = await address(host);
    const upstream = net.connect(443, ip, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.setTimeout(120000, () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  } catch {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
});
server.maxConnections = 80;
server.listen(3128, "0.0.0.0");
