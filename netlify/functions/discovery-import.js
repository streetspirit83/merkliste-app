/**
 * discovery-import.js — Proxy zum Screener-Discovery-Projekt
 *
 * Holt den discovery-export Blob (HTTP-Endpoint des separaten
 * "screener discovery" Netlify-Projekts) server-seitig und reicht das
 * JSON durch. Server-seitiger Fetch vermeidet CORS-Probleme und hält die
 * Quell-URL geheim (Env-Var statt im Client-Code).
 *
 * Ein optionaler ?scope=live wird an den Upstream durchgereicht: der manuelle
 * Import lässt ihn weg (→ nur Export-Bucket, legt neu an), der Onload-Kurs-
 * Refresh setzt scope=live (→ Union inbox+watch+export, aktualisiert nur
 * bereits getrackte Ticker).
 *
 * Env: DISCOVERY_EXPORT_URL — voll qualifizierte URL des Export-Endpoints,
 *      z.B. https://screener-discovery.netlify.app/.netlify/functions/discovery-export
 */

export default async (req) => {
  const url = process.env.DISCOVERY_EXPORT_URL;
  if (!url) {
    return new Response(
      JSON.stringify({ error: "DISCOVERY_EXPORT_URL nicht konfiguriert" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  // scope=live (nur dieser Wert) an den Upstream weiterreichen.
  const scope = new URL(req.url).searchParams.get("scope");
  const upstream = scope === "live"
    ? `${url}${url.includes("?") ? "&" : "?"}scope=live`
    : url;

  try {
    const res = await fetch(upstream, { headers: { Accept: "application/json" } });
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
