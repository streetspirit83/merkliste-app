/**
 * check-alerts.js — Scheduled function: Status-Vergleich + ntfy.sh Push
 * Schedule (netlify.toml): alle 30 Min, Mo-Fr 9-22 Uhr
 *
 * Ablauf:
 *  1. Tickers aus Blob (key "main") lesen
 *  2. Vorherigen Alert-Status aus Blob (key "alert-state") lesen
 *  3. Fresh-Preis je Ticker von Yahoo holen (parallel, Batches à 5)
 *  4. computeStatus mit enriched quotes (fresh price + stored indicators)
 *  5. Statuswechsel → ntfy.sh Push
 *  6. Neuen Status in Blob (key "alert-state") speichern
 */

import { getStore }                  from "@netlify/blobs";
import { computeStatus, STATUS_MAP } from "./lib/status-logic.js";
import { sendNtfy }                  from "./lib/notify.js";

const NTFY_TOPIC  = process.env.NTFY_TOPIC || "mlst-alerts-h3m8w1";
const TICKER_KEY  = "main";
const STATE_KEY   = "alert-state";
const BATCH_SIZE  = 5;
const BATCH_PAUSE = 300; // ms zwischen Batches

/* ── Yahoo: nur aktuellen Preis holen (range=1d) ──────────────────── */

const YAHOO_BASES = [
  "https://query2.finance.yahoo.com/v8/finance/chart",
  "https://query1.finance.yahoo.com/v8/finance/chart",
];
const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
];

async function fetchFreshPrice(symbol) {
  const params = new URLSearchParams({ interval: "1d", range: "1d", includePrePost: "false" });
  for (let i = 0; i < YAHOO_BASES.length; i++) {
    try {
      const res = await fetch(
        `${YAHOO_BASES[i]}/${encodeURIComponent(symbol)}?${params}`,
        {
          headers: {
            "User-Agent":      UA_POOL[i % UA_POOL.length],
            "Accept":          "application/json",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer":         "https://finance.yahoo.com/",
            "Origin":          "https://finance.yahoo.com",
          },
        }
      );
      if (!res.ok) continue;
      const data   = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      return result.meta?.regularMarketPrice ?? null;
    } catch {
      continue;
    }
  }
  return null; // Fallback: gespeicherter Preis wird genutzt
}

/* ── Performance-% aus Entry-Preis + aktuellem Preis ─────────────── */

function computePerfPct(ticker, freshPrice) {
  const ep    = ticker.user?.entry_price_manual;
  const price = freshPrice ?? ticker.quotes?.price;
  if (ep == null || price == null || ep === 0)
    return ticker.calculations?.trends?.performance_pct ?? null;
  return ((price - ep) / ep) * 100;
}

/* ── Batch-Helper ─────────────────────────────────────────────────── */

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function batchFetchPrices(tickers) {
  const prices = {};
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async t => {
        const p = await fetchFreshPrice(t.stamm.symbol);
        prices[t.id] = p;
        console.log(`[yahoo] ${t.stamm.symbol}: ${p ?? "—"}`);
      })
    );
    if (i + BATCH_SIZE < tickers.length) await sleep(BATCH_PAUSE);
  }
  return prices;
}

/* ── Handler (Functions v2) ───────────────────────────────────────── */

export default async () => {
  const now = new Date().toISOString();
  console.log(`[check-alerts] Start: ${now}`);

  const store = getStore("merkliste");

  // 1. Tickers lesen
  const blobData = await store.get(TICKER_KEY, { type: "json" }).catch(() => null);
  if (!blobData?.tickers?.length) {
    console.log("[check-alerts] Kein Blob oder leere Ticker-Liste");
    return { statusCode: 200, body: "no data" };
  }

  // 2. Vorherigen Alert-Status lesen
  const prevData = await store.get(STATE_KEY, { type: "json" }).catch(() => null);
  const prevState = prevData?.state ?? {};

  // 3. Nur Ticker mit Alerts
  const alertTickers = blobData.tickers.filter(t => t.user?.alerts?.length > 0);
  console.log(`[check-alerts] ${alertTickers.length} Ticker mit Alerts / ${blobData.tickers.length} gesamt`);

  // 4. Fresh-Preise von Yahoo holen
  const freshPrices = await batchFetchPrices(alertTickers);

  // 5. Status berechnen + vergleichen
  const newState  = { ...prevState };
  let   pushCount = 0;

  for (const ticker of alertTickers) {
    const symbol   = ticker.stamm?.symbol;
    const freshP   = freshPrices[ticker.id] ?? null;
    const enrichedQ = {
      ...ticker.quotes,
      ...(freshP != null ? { price: freshP } : {}),
      _perf_pct: computePerfPct(ticker, freshP),
    };

    const status  = computeStatus(ticker, enrichedQ);
    const prevKey = prevState[ticker.id] ?? "halten";
    newState[ticker.id] = status.key;

    if (prevKey === status.key || status.key === "halten") {
      console.log(`[OK]    ${status.emoji} ${symbol}: ${status.key} (unverändert)`);
      continue;
    }

    // Statuswechsel → Push
    const info    = STATUS_MAP[status.key] || STATUS_MAP.halten;
    const title   = `${info.emoji} ${symbol}: ${info.label}`;
    const priceStr = freshP != null ? `${freshP.toFixed(2)}` : "—";
    const message  = `${ticker.stamm.name || symbol}\n${prevKey} → ${status.key}\nKurs: ${priceStr}`;

    console.log(`[ALERT] ${title} | ${prevKey} → ${status.key}`);
    await sendNtfy(NTFY_TOPIC, { title, message, pushColor: info.pushColor });
    pushCount++;
  }

  // 6. Neuen Status speichern
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
