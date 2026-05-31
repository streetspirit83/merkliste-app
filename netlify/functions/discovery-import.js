/**
 * discovery-import.js — Proxy zum Screener-Discovery-Projekt
 *
 * Holt den discovery-export Blob (HTTP-Endpoint des separaten
 * "screener discovery" Netlify-Projekts) server-seitig und reicht das
 * JSON durch. Server-seitiger Fetch vermeidet CORS-Probleme und hält die
 * Quell-URL geheim (Env-Var statt im Client-Code).
 *
 * Env: DISCOVERY_EXPORT_URL — voll qualifizierte URL des Export-Endpoints,
 *      z.B. https://screener-discovery.netlify.app/.netlify/functions/discovery-export
 */

export default async () => {
  const url = process.env.DISCOVERY_EXPORT_URL;
  if (!url) {
    return new Response(
      JSON.stringify({ error: "DISCOVERY_EXPORT_URL nicht konfiguriert" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Discovery HTTP ${res.status}` }),
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
