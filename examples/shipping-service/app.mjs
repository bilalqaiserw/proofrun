import http from "node:http";
import { readFile } from "node:fs/promises";
import { quote } from "./shipping.mjs";
const html = await readFile(new URL("./index.html", import.meta.url));
http.createServer((req, res) => {
  const url = new URL(req.url, "http://app");
  if (req.method === "GET" && url.pathname === "/") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(html);
  }
  res.setHeader("content-type", "application/json");
  if (req.method !== "GET" || url.pathname !== "/quote") {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: "Route not found" }));
  }
  const raw = url.searchParams.get("subtotal");
  const result = quote(raw === null || raw.trim() === "" ? NaN : Number(raw));
  res.writeHead(result.error ? 400 : 200);
  res.end(JSON.stringify(result));
}).listen(Number(process.env.PORT || 3100), "127.0.0.1", () => console.log("Shipping service ready"));
