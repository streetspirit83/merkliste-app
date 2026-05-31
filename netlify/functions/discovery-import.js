/**
 * discovery-import.js — Liest discovery-export Blob direkt via Netlify REST API
 *
 * Kein Endpoint auf der Discovery-Seite nötig — wir rufen die Netlify Blobs
 * REST API des fremden Sites direkt auf, authentifiziert mit einem
 * persönlichen Netlify Access Token.
 *
 * Env-Vars (im merkliste Netlify-Projekt setzen):
 *   DISCOVERY_SITE_ID    — Site-ID des Discovery-Projekts (UUID, Netlify Dashboard → Site settings)
 *   DISCOVERY_STORE_NAME — Name des Blob-Stores im Discovery-Projekt (z.B. "discovery")
 *   DISCOVERY_BLOB_KEY   — Blob-Key (default: "discovery-export")
 *   NETLIFY_TOKEN        — Persönlicher Netlify Access Token (User settings → OAuth applications)
 */

const API_BASE = "https://api.netlify.com/api/v1/blobs";

export default async () => {
  const siteId    = process.env.DISCOVERY_SITE_ID;
  const storeName = process.env.DISCOVERY_STORE_NAME;
  const blobKey   = process.env.DISCOVERY_BLOB_KEY || "discovery-export";
  const token     = process.env.NETLIFY_TOKEN;

  const missing = [
    !siteId    && "DISCOVERY_SITE_ID",
    !storeName && "DISCOVERY_STORE_NAME",
    !token     && "NETLIFY_TOKEN",
  ].filter(Boolean);

  if (missing.length) {
    return new Response(
      JSON.stringify({ error: `Env-Vars fehlen: ${missing.join(", ")}` }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const url = `${API_BASE}/${siteId}/${storeName}/${encodeURIComponent(blobKey)}`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (res.status === 404) {
      return new Response(
        JSON.stringify({ error: "Blob nicht gefunden (store/key prüfen)" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    if (res.status === 401 || res.status === 403) {
      return new Response(
        JSON.stringify({ error: `Netlify Auth fehlgeschlagen (HTTP ${res.status}) — Token prüfen` }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Netlify API HTTP ${res.status}` }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config = { path: "/.netlify/functions/discovery-import" };
