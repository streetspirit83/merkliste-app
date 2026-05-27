/**
 * check-alerts.js — Scheduled function: Status-Vergleich + ntfy.sh Push
 * Schedule: alle 30 Min, Mo-Fr 9-22 Uhr
 *
 * Ablauf:
 *  1. Tickers aus Blob lesen
 *  2. Vorherigen Alert-Status aus Blob lesen
 *  3. EUR/USD-Rate live von Yahoo holen (EURUSD=X)
 *  4. Fresh-Preis je Ticker von Yahoo (yahoo_symbol || symbol, Batches à 5)
 *  5. Preis in Display-Währung (EUR) konvertieren — gleiche Logik wie Browser
 *  6. computeStatus → Statuswechsel → ntfy.sh Push
 *  7. Neuen Status in Blob speichern
 */

import { getStore }                  from "@netlify/blobs";
import { computeStatus, STATUS_MAP, evalAlert } from "./lib/status-logic.js";
import { sendNtfy }                  from "./lib/notify.js";

const NTFY_TOPIC  = process.env.NTFY_TOPIC || "mlst-alerts-h3m8w1";
const TICKER_KEY  = "main";
const STATE_KEY   = "alert-state";
const PREV_KEY    = "prev-quotes";   // Reversal-Alerts: _prev zwischen Runs
const BATCH_SIZE  = 5;
const BATCH_PAUSE = 300;

/* ── Yahoo fetch ─────────────────────────────────────────────────── */

const YAHOO_BASES = [
  "https://query2.finance.yahoo.com/v8/finance/chart",
  "https://query1.finance.yahoo.com/v8/finance/chart",
];
const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
];

async function yahooFetch(symbol) {
  const params = new URLSearchParams({ interval: "1d", range: "1d", includePrePost: "false" });
  for (let i = 0; i < YAHOO_BASES.length; i++) {
    try {
      const res = await fetch(
        `${YAHOO_BASES[i]}/${encodeURIComponent(symbol)}?${params}`,
        { headers: { "User-Agent": UA_POOL[i % UA_POOL.length], "Referer": "https://finance.yahoo.com/" } }
      );
      if (!res.ok) continue;
      const data   = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      return result;
    } catch { continue; }
  }
  return null;
}

async function fetchPrice(symbol) {
  const result = await yahooFetch(symbol);
  if (!result) return null;
  const p = result.meta?.regularMarketPrice;
  return p != null ? +p : null;
}

/* Fetch EUR/USD rate — fallback 1.0 (no conversion) */
async function fetchEurUsd() {
  try {
    const result = await yahooFetch("EURUSD=X");
    const rate = result?.meta?.regularMarketPrice;
    if (rate && rate > 0) {
      console.log(`[check-alerts] EUR/USD: ${rate.toFixed(4)}`);
      return rate;
    }
  } catch { /* ignore */ }
  console.log("[check-alerts] EUR/USD: nicht verfügbar, kein Konvert");
  return null;
}

/* ── EUR-Konvertierung (identisch mit Browser Calc.recompute) ─────── */

function toDisplayPrice(rawPrice, ticker, eurUsd) {
  const ccy = ticker.quotes?.currency_returned || ticker.stamm?.currency || "";
  if (ccy === "USD" && eurUsd && rawPrice != null) return +(rawPrice / eurUsd).toFixed(4);
  return rawPrice;
}

function computePerfPct(ticker, displayPrice, eurUsd) {
  const ccy = ticker.quotes?.currency_returned || ticker.stamm?.currency || "";
  // Ohne EUR/USD-Rate ist der USD-Kurs nicht in EUR → Berechnung unzuverlässig
  if (ccy === "USD" && !eurUsd) return ticker.calculations?.trends?.performance_pct ?? null;
  const ep = ticker.user?.entry_price_manual;
  if (ep == null || displayPrice == null || ep === 0)
    return ticker.calculations?.trends?.performance_pct ?? null;
  return ((displayPrice - ep) / ep) * 100;
}

/* ── Alert-Detail für Push ───────────────────────────────────────── */

function alertDetail(alert, q) {
  const th = alert.threshold != null ? alert.threshold : null;
  const p  = q.price != null ? q.price.toFixed(2) : "—";
  switch (alert.type) {
    case "price_below":  return `Preis ${p} ≤ ${th}`;
    case "price_above":  return `Preis ${p} ≥ ${th}`;
    case "perf_below":   return `Perf ${q._perf_pct?.toFixed(1)}% ≤ −${th}%`;
    case "perf_above":   return `Perf ${q._perf_pct?.toFixed(1)}% ≥ +${th}%`;
    case "rsi_below":    return `RSI ${q.rsi?.toFixed(1)} ≤ ${th}`;
    case "rsi_above":    return `RSI ${q.rsi?.toFixed(1)} ≥ ${th}`;
    case "macd_bullish": return `MACD Hist ${q.macd_histogram?.toFixed(3)} > 0`;
    case "macd_bearish": return `MACD Hist ${q.macd_histogram?.toFixed(3)} < 0`;
    default:             return alert.type;
  }
}

function buildMessage(ticker, status, prevKey, triggeredAlerts, enrichedQ) {
  const u    = ticker.user || {};
  const name = ticker.stamm?.name;
  const lines = [`${prevKey} → ${status.key}`];
  if (triggeredAlerts.length) lines.push(triggeredAlerts.map(a => alertDetail(a, enrichedQ)).join(", "));
  if (name)                   lines.push(name);
  if (u.entry_shares != null) lines.push(`Bestand: ${u.entry_shares} Stk.`);
  if (u.notes)                lines.push(`Notiz: ${u.notes}`);
  return lines.join("\n");
}

/* ── Batch fetch ─────────────────────────────────────────────────── */

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function batchFetchPrices(tickers) {
  const prices = {};
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async t => {
      const sym = t.stamm.yahoo_symbol || t.stamm.symbol;
      const p   = await fetchPrice(sym);
      prices[t.id] = p;
      console.log(`[yahoo] ${t.stamm.symbol}${sym !== t.stamm.symbol ? ` (${sym})` : ""}: ${p ?? "—"}`);
    }));
    if (i + BATCH_SIZE < tickers.length) await sleep(BATCH_PAUSE);
  }
  return prices;
}

/* ── Handler ──────────────────────────────────────────────────────── */

export default async () => {
  console.log(`[check-alerts] Start: ${new Date().toISOString()}`);

  const store = getStore("merkliste");

  const blobData = await store.get(TICKER_KEY, { type: "json" }).catch(() => null);
  if (!blobData?.tickers?.length) {
    console.log("[check-alerts] Kein Blob oder leere Ticker-Liste");
    return new Response("no data", { status: 200 });
  }

  const prevData      = await store.get(STATE_KEY,  { type: "json" }).catch(() => null);
  const prevState     = prevData?.state ?? {};
  const prevQData     = await store.get(PREV_KEY,   { type: "json" }).catch(() => null);
  const prevQuotesMap = prevQData?.quotes ?? {};

  // EUR/USD live von Yahoo
  const eurUsd = await fetchEurUsd();

  // vol_spike aus Push-Auswertung ausschließen (Volume-Daten im Blob sind stale)
  const alertTickers = blobData.tickers.filter(t =>
    (t.user?.alerts || []).some(a => a.type !== "vol_spike")
  );
  console.log(`[check-alerts] ${alertTickers.length} Ticker mit Push-Alerts / ${blobData.tickers.length} gesamt`);

  const freshPrices = await batchFetchPrices(alertTickers);

  const newState      = { ...prevState };
  const newPrevQuotes = {};
  let   pushCount     = 0;

  for (const ticker of alertTickers) {
    const symbol    = ticker.stamm?.symbol;
    const rawPrice  = freshPrices[ticker.id] ?? null;
    const dispPrice = toDisplayPrice(rawPrice, ticker, eurUsd);
    const perfPct   = computePerfPct(ticker, dispPrice, eurUsd); // 3.1: eurUsd-Guard

    const ccy    = ticker.quotes?.currency_returned || ticker.stamm?.currency || "";
    const toEur  = v => (ccy === "USD" && eurUsd && v != null) ? +(v / eurUsd).toFixed(4) : v;

    // 3.2: _prev aus letztem Run für Reversal-Alerts
    const prevQ  = prevQuotesMap[ticker.id] ?? null;
    const enrichedQ = {
      ...ticker.quotes,
      price: dispPrice ?? toEur(ticker.quotes?.price),
      ma20:  toEur(ticker.quotes?.ma20),
      ma50:  toEur(ticker.quotes?.ma50),
      ma200: toEur(ticker.quotes?.ma200),
      _perf_pct: perfPct,
      _prev: prevQ ?? null,
    };

    // 3.3: vol_spike für computeStatus ausblenden (stale volume)
    const pushAlerts = (ticker.user?.alerts || []).filter(a => a.type !== "vol_spike");
    const pushTicker = { ...ticker, user: { ...ticker.user, alerts: pushAlerts } };
    const status     = computeStatus(pushTicker, enrichedQ);
    const prevKey    = prevState[ticker.id] ?? "halten";
    newState[ticker.id] = status.key;

    // 3.2: aktuellen Stand für nächsten Run speichern (EUR-konvertiert)
    newPrevQuotes[ticker.id] = {
      price:          dispPrice ?? null,
      macd_histogram: ticker.quotes?.macd_histogram ?? null,
      ma200:          toEur(ticker.quotes?.ma200 ?? null),
    };

    console.log(`[eval] ${symbol}: disp=${dispPrice?.toFixed(2) ?? "—"} perf=${perfPct?.toFixed(1) ?? "—"}% → ${status.key} (prev: ${prevKey})`);

    if (prevKey === status.key || status.key === "halten") {
      console.log(`[OK]   ${status.emoji} ${symbol}: kein Push`);
      continue;
    }

    const info            = STATUS_MAP[status.key] || STATUS_MAP.halten;
    const triggeredAlerts = pushAlerts.filter(a => evalAlert(a, enrichedQ));
    const title   = `${info.emoji} ${symbol}: ${info.label}`;
    const message = buildMessage(ticker, status, prevKey, triggeredAlerts, enrichedQ);

    console.log(`[ALERT] ${title}\n${message}`);
    await sendNtfy(NTFY_TOPIC, { title, message, pushColor: info.pushColor });
    pushCount++;
  }

  await Promise.all([
    store.setJSON(STATE_KEY, { state: newState, updatedAt: Date.now() }),
    store.setJSON(PREV_KEY,  { quotes: newPrevQuotes, updatedAt: Date.now() }),
  ]);
  console.log(`[check-alerts] Fertig: ${pushCount} Alert(s) gepusht`);

  return new Response(JSON.stringify({ alerts: pushCount }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  schedule: "*/18 9-22 * * 1-5",
};
