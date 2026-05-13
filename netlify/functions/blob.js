/**
 * blob.js — Netlify Blobs cloud storage für Merkliste
 * GET  → { tickers, savedAt, version } | 404
 * POST → { ok, savedAt }
 */

import { getStore } from "@netlify/blobs";

const KEY = "main";

export default async (req) => {
  const store = getStore("merkliste");

  if (req.method === "GET") {
    try {
      const data = await store.get(KEY, { type: "json" });
      if (!data) {
        return new Response(JSON.stringify({ error: "not-found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
  }

  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (!body || !Array.isArray(body.tickers)) {
        return new Response(JSON.stringify({ error: "invalid payload" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      if (JSON.stringify(body).length > 5_000_000) {
        return new Response(JSON.stringify({ error: "payload too large" }), {
          status: 413, headers: { "Content-Type": "application/json" }
        });
      }
      await store.setJSON(KEY, body);
      return new Response(JSON.stringify({ ok: true, savedAt: body.savedAt || Date.now() }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/.netlify/functions/blob" };
