/**
 * portfolio-value.js — Gesamtwert des Portfolios als JSON
 * GET → {
 *   gesamtwert, investiert, pl_abs, pl_pct, waehrung: "EUR",
 *   positionen, live_kurse, fallback_kurse, eur_usd, stand
 * }
 *
 * Rechnet wie die Portfolio-Übersicht im Browser (renderPortfolioPerf / Calc.position):
 *  - nur Ticker mit user.bucket === "portfolio"
 *  - nur Positionen mit Kurs, entry_price_manual und entry_shares
 *  - Wert = Kurs × Stück; USD-Kurse werden mit EUR/USD in EUR umgerechnet
 * Kurse kommen frisch von Yahoo; schlägt das fehl, wird der zuletzt gespeicherte
 * Kurs aus dem Blob genutzt (gezählt in fallback_kurse).
 * Wird u. a. vom Familienfinanzen-Dashboard (Claude-Artefakt) täglich abgefragt.
 */

import { getStore } from "@netlify/blobs";

const TICKER_KEY = "main";
const BATCH_SIZE = 8;
const FETCH_TIMEOUT_MS = 4000;

const YAHOO_BASES = [
  "https://query2.finance.yahoo.com/v8/finance/chart",
  "https://query1.finance.yahoo.com/v8/finance/chart",
];
const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
];

async function yahooMeta(symbol) {
  const params = new URLSearchParams({ interval: "1d", range: "1d", includePrePost: "false" });
  for (let i = 0; i < YAHOO_BASES.length; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${YAHOO_BASES[i]}/${encodeURIComponent(symbol)}?${params}`, {
        headers: { "User-Agent": UA_POOL[i % UA_POOL.length], "Referer": "https://finance.yahoo.com/" },
        signal: ctrl.signal,
      });
      if (!res.ok) continue;
      const meta = (await res.json())?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice != null) return meta;
    } catch { /* nächster Versuch */ }
    finally { clearTimeout(timer); }
  }
  return null;
}

/* gleiche Heuristik wie API._guessYahooSymbol im Browser */
function yahooSymbol(t) {
  const s = t.stamm || {};
  if (s.yahoo_symbol) return s.yahoo_symbol;
  const base = s.twelvedata_symbol || s.symbol;
  if (!base) return null;
  const mic = (s.twelvedata_mic_code || "").toUpperCase();
  const exch = (s.twelvedata_exchange || s.exchange || "").toUpperCase();
  const micMap = {
    XETR: ".DE", XFRA: ".F", XAMS: ".AS", XSWX: ".SW", XPAR: ".PA", XLON: ".L", XSTO: ".ST",
    XHEL: ".HE", XCSE: ".CO", XOSL: ".OL", XMIL: ".MI", XMAD: ".MC", XBRU: ".BR", XLIS: ".LS",
    XWAR: ".WA", XNAS: "", XNYS: "", ARCX: "", BATS: "",
  };
  if (mic in micMap) return base + micMap[mic];
  if (exch.includes("XETRA") || exch.includes("FRANKFURT")) return base + ".DE";
  if (exch.includes("STOCKHOLM")) return base + ".ST";
  if (exch.includes("LONDON")) return base + ".L";
  if (exch.includes("AMSTERDAM")) return base + ".AS";
  if (exch.includes("PARIS")) return base + ".PA";
  if (exch.includes("MILAN")) return base + ".MI";
  if (exch.includes("MADRID")) return base + ".MC";
  return base;
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });

export default async (req) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const data = await getStore("merkliste").get(TICKER_KEY, { type: "json" }).catch(() => null);
  if (!data?.tickers) return json({ error: "not-found" }, 404);

  const held = data.tickers.filter(t =>
    t.user?.bucket === "portfolio" &&
    t.user?.entry_price_manual != null &&
    t.user?.entry_shares != null && t.user.entry_shares > 0
  );

  const fxMeta = await yahooMeta("EURUSD=X");
  const eurUsd = fxMeta?.regularMarketPrice > 0 ? +fxMeta.regularMarketPrice : (data.config?.eur_usd ?? null);

  const metas = {};
  for (let i = 0; i < held.length; i += BATCH_SIZE) {
    const batch = held.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async t => {
      const sym = yahooSymbol(t);
      metas[t.id] = sym ? await yahooMeta(sym) : null;
    }));
  }

  let wert = 0, kosten = 0, live = 0, fallback = 0, ohneKurs = 0;
  for (const t of held) {
    const m = metas[t.id];
    let raw = m?.regularMarketPrice ?? null;
    let ccy = m?.currency || null;
    if (raw != null) live++;
    else {
      raw = t.quotes?.price ?? null;
      if (raw == null) { ohneKurs++; continue; }
      fallback++;
    }
    ccy = ccy || t.quotes?.currency_returned || t.stamm?.currency || "";
    const price = (ccy === "USD" && eurUsd) ? raw / eurUsd : raw;
    wert += price * t.user.entry_shares;
    kosten += t.user.entry_price_manual * t.user.entry_shares;
  }

  const pl = wert - kosten;
  return json({
    gesamtwert: +wert.toFixed(2),
    investiert: +kosten.toFixed(2),
    pl_abs: +pl.toFixed(2),
    pl_pct: kosten > 0 ? +((pl / kosten) * 100).toFixed(2) : null,
    waehrung: "EUR",
    positionen: held.length,
    live_kurse: live,
    fallback_kurse: fallback,
    ohne_kurs: ohneKurs,
    eur_usd: eurUsd,
    stand: new Date().toISOString(),
  }, 200, { "Cache-Control": "public, max-age=300" });
};

export const config = { path: "/.netlify/functions/portfolio-value" };
