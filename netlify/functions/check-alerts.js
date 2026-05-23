/**
 * check-alerts.js — Scheduled function: Status-Vergleich + ntfy.sh Push
 * Schedule: alle 30 Min, Mo-Fr 9-22 Uhr (config.schedule unten)
 *
 * Ablauf:
 *  1. Tickers + Config aus Blob lesen
 *  2. Vorherigen Alert-Status aus Blob lesen
 *  3. Fresh-Preis holen: US-Ticker via TD, Rest via Yahoo (Batches à 5)
 *  4. computeStatus mit enriched quotes (fresh price + stored indicators)
 *  5. Statuswechsel != halten → ntfy.sh Push mit Details
 *  6. Neuen Status in Blob speichern
 */

import { getStore }                  from "@netlify/blobs";
import { computeStatus, STATUS_MAP } from "./lib/status-logic.js";
import { sendNtfy }                  from "./lib/notify.js";

const NTFY_TOPIC  = process.env.NTFY_TOPIC || "mlst-alerts-h3m8w1";
const TICKER_KEY  = "main";
const STATE_KEY   = "alert-state";
const BATCH_SIZE  = 5;
const BATCH_PAUSE = 300;

/* ── Exchange-Routing: US via TD, Rest via Yahoo ──────────────────── */

const US_MICS = new Set(["XNYS", "XNAS", "XNGS", "XNCM", "XNMS", "ARCX", "BATS"]);
function isUSTicker(t) {
  const mic  = (t.stamm?.twelvedata_mic_code || "").toUpperCase();
  const exch = (t.stamm?.twelvedata_exchange || t.stamm?.exchange || "").toUpperCase();
  if (US_MICS.has(mic)) return true;
  if (exch.includes("NASDAQ") || exch.includes("NYSE") || exch.includes("ARCA")) return true;
  return false;
}

/* ── TwelveData: aktuellen Preis holen ───────────────────────────── */

async function fetchPriceTD(symbol, apiKey) {
  try {
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === "error" || data.code) return null;
    const p = parseFloat(data.price);
    return isNaN(p) ? null : p;
  } catch { return null; }
}

/* ── Yahoo: aktuellen Preis holen ────────────────────────────────── */

const YAHOO_BASES = [
  "https://query2.finance.yahoo.com/v8/finance/chart",
  "https://query1.finance.yahoo.com/v8/finance/chart",
];
const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
];

async function fetchPriceYahoo(symbol) {
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
      const p = result.meta?.regularMarketPrice;
      return p != null ? p : null;
    } catch { continue; }
  }
  return null;
}

/* ── EUR/USD-Konvertierung (wie im Browser) ──────────────────────── */

function toDisplayPrice(rawPrice, ticker, eurUsd) {
  const ccy = ticker.quotes?.currency_returned || ticker.stamm?.currency || "";
  if (ccy === "USD" && eurUsd && rawPrice != null) return rawPrice / eurUsd;
  return rawPrice;
}

/* ── Performance-% aus Entry-Preis + Display-Preis ──────────────── */

function computePerfPct(ticker, displayPrice) {
  const ep = ticker.user?.entry_price_manual;
  if (ep == null || displayPrice == null || ep === 0)
    return ticker.calculations?.trends?.performance_pct ?? null;
  return ((displayPrice - ep) / ep) * 100;
}

/* ── Triggered-Alert-Details für Push-Nachricht ─────────────────── */

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

/* ── Push-Nachricht aufbauen ─────────────────────────────────────── */

function buildMessage(ticker, status, prevKey, triggeredAlerts, enrichedQ) {
  const u    = ticker.user  || {};
  const name = ticker.stamm?.name;
  const lines = [`${prevKey} → ${status.key}`];

  if (triggeredAlerts.length) {
    lines.push(triggeredAlerts.map(a => alertDetail(a, enrichedQ)).join(", "));
  }
  if (name)                   lines.push(name);
  if (u.entry_shares != null) lines.push(`Bestand: ${u.entry_shares} Stk.`);
  if (u.notes)                lines.push(`Notiz: ${u.notes}`);

  return lines.join("\n");
}

/* ── Batch-Fetch ─────────────────────────────────────────────────── */

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function batchFetchPrices(tickers, tdKey) {
  const prices = {};
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async t => {
      const usesTD = isUSTicker(t) && tdKey;
      const sym    = usesTD ? (t.stamm.twelvedata_symbol || t.stamm.symbol) : t.stamm.symbol;
      const p      = usesTD ? await fetchPriceTD(sym, tdKey) : await fetchPriceYahoo(sym);
      prices[t.id] = p;
      console.log(`[price] ${t.stamm.symbol} via ${usesTD ? "TD" : "Yahoo"}: ${p ?? "—"}`);
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

  const prevData  = await store.get(STATE_KEY, { type: "json" }).catch(() => null);
  const prevState = prevData?.state ?? {};
  const eurUsd    = blobData.config?.eur_usd ?? null;
  const tdKey     = blobData.config?.twelveDataKey || null;

  console.log(`[check-alerts] EUR/USD: ${eurUsd ?? "nicht gesetzt"} | TD-Key: ${tdKey ? "✓" : "—"}`);

  const alertTickers = blobData.tickers.filter(t => t.user?.alerts?.length > 0);
  console.log(`[check-alerts] ${alertTickers.length} Ticker mit Alerts / ${blobData.tickers.length} gesamt`);

  const freshPrices = await batchFetchPrices(alertTickers, tdKey);

  const newState  = { ...prevState };
  let   pushCount = 0;

  for (const ticker of alertTickers) {
    const symbol   = ticker.stamm?.symbol;
    const rawPrice = freshPrices[ticker.id] ?? null;
    const dispPrice = toDisplayPrice(rawPrice, ticker, eurUsd);
    const perfPct   = computePerfPct(ticker, dispPrice);

    const enrichedQ = {
      ...ticker.quotes,
      ...(dispPrice != null ? { price: dispPrice } : {}),
      _perf_pct: perfPct,
    };

    const status  = computeStatus(ticker, enrichedQ);
    const prevKey = prevState[ticker.id] ?? "halten";
    newState[ticker.id] = status.key;

    // Debug-Log: immer Preis + Status zeigen
    console.log(`[eval] ${symbol}: raw=${rawPrice?.toFixed(2) ?? "—"} disp=${dispPrice?.toFixed(2) ?? "—"} perf=${perfPct?.toFixed(1) ?? "—"}% status=${status.key} prev=${prevKey}`);

    if (prevKey === status.key || status.key === "halten") {
      console.log(`[OK]   ${status.emoji} ${symbol}: ${status.key} (kein Push)`);
      continue;
    }

    const info           = STATUS_MAP[status.key] || STATUS_MAP.halten;
    const triggeredAlerts = (ticker.calculations?.smart_alerts || ticker.user?.alerts || [])
      .filter(a => a._trig);
    const title   = `${info.emoji} ${symbol}: ${info.label}`;
    const message = buildMessage(ticker, status, prevKey, triggeredAlerts, enrichedQ);

    console.log(`[ALERT] ${title}\n${message}`);
    await sendNtfy(NTFY_TOPIC, { title, message, pushColor: info.pushColor });
    pushCount++;
  }

  await store.setJSON(STATE_KEY, { state: newState, updatedAt: Date.now() });
  console.log(`[check-alerts] Fertig: ${pushCount} Alert(s) gepusht`);

  return new Response(JSON.stringify({ alerts: pushCount }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  schedule: "*/30 9-22 * * 1-5",
};
