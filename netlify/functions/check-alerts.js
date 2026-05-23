/**
 * check-alerts.js — Scheduled function: status-change detection + push alerts.
 *
 * Phase 2: Mock-Daten + console.log statt echtem Push und Blob.
 * Phase 3: echte Blob-Daten lesen, ntfy.sh Push, neuen Zustand speichern.
 *
 * Schedule (netlify.toml): "*/30 9-22 * * 1-5"
 */

import { computeStatus, STATUS_MAP } from './lib/status-logic.js';

/* ── Mock-Daten (Phase 2) ───────────────────────────────────────────── */

const MOCK_TICKERS = [
  {
    id: "mock-1",
    stamm: { symbol: "AAPL", name: "Apple Inc." },
    user: {
      alerts: [
        { type: "price_below", threshold: 200, dir: "buy" }, // Kurs 185 < 200 → 💵 Kauf
      ]
    },
    quotes: { price: 185 },
    calculations: { trends: { performance_pct: 8 } }
  },
  {
    id: "mock-2",
    stamm: { symbol: "TSLA", name: "Tesla" },
    user: {
      alerts: [
        { type: "price_below", threshold: 170, dir: "sell" }, // Kurs 180 > 170 → kein Trigger
        { type: "perf_below",  threshold: 15,  dir: "sell" }, // Perf -18% ≤ -15% → ↘ Verkauf
      ]
    },
    quotes: { price: 180 },
    calculations: { trends: { performance_pct: -18 } }
  },
  {
    id: "mock-3",
    stamm: { symbol: "NVDA", name: "Nvidia" },
    user: {
      alerts: [
        { type: "perf_above", threshold: 20, dir: "sell" }, // Perf +25% ≥ +20% → 💰 Kursziel
      ]
    },
    quotes: { price: 900 },
    calculations: { trends: { performance_pct: 25 } }
  },
  {
    id: "mock-4",
    stamm: { symbol: "SAP", name: "SAP SE" },
    user: {
      alerts: [
        { type: "macd_bearish" }, // MACD Histogram < 0 → 🔴 Momentum negativ
      ]
    },
    quotes: { price: 180, macd_histogram: -0.42 },
    calculations: { trends: { performance_pct: 3 } }
  },
  {
    id: "mock-5",
    stamm: { symbol: "DBK", name: "Deutsche Bank" },
    user: { alerts: [] },
    quotes: { price: 14 },
    calculations: { trends: { performance_pct: 2 } }
  }
];

// Simulierter vorheriger Zustand (Phase 3: kommt aus Blob)
const MOCK_PREV_STATUS = {
  "mock-1": "halten",       // → Kauf:         Statuswechsel → Push!
  "mock-2": "halten",       // → Verkauf:       Statuswechsel → Push!
  "mock-3": "kursziel",     // → Kursziel:      unverändet    → kein Push
  "mock-4": "momentum_neg", // → Momentum neg:  unverändert   → kein Push
  "mock-5": "halten",       // → Halten:        unverändert   → kein Push
};

/* ── Helpers ────────────────────────────────────────────────────────── */

function buildEnrichedQ(ticker) {
  return {
    ...ticker.quotes,
    _perf_pct: ticker.calculations?.trends?.performance_pct ?? null,
  };
}

function shouldPush(prevKey, newKey) {
  // Nur pushen wenn Status sich geändert hat UND neuer Status nicht Halten ist
  return prevKey !== newKey && newKey !== "halten";
}

/* ── Handler ────────────────────────────────────────────────────────── */

export const handler = async () => {
  const now = new Date().toISOString();
  console.log(`[check-alerts] Start: ${now}`);

  const results = [];

  for (const ticker of MOCK_TICKERS) {
    const { symbol, name } = ticker.stamm;
    const enrichedQ = buildEnrichedQ(ticker);
    const status    = computeStatus(ticker, enrichedQ);
    const prevKey   = MOCK_PREV_STATUS[ticker.id] ?? "halten";
    const changed   = shouldPush(prevKey, status.key);

    results.push({ symbol, status: status.key, prev: prevKey, changed });

    if (changed) {
      const info = STATUS_MAP[status.key] || STATUS_MAP.halten;
      // Phase 3: hier ntfy.sh Push einfügen
      console.log(`[ALERT] ${info.emoji} ${symbol} (${name})`);
      console.log(`  Status: ${prevKey} → ${status.key} (${info.label})`);
      console.log(`  Push-Farbe: ${info.pushColor ?? "—"}`);
      console.log(`  [Phase 3] → ntfy POST an topic mlst-alerts-h3m8w1`);
    } else {
      console.log(`[OK]    ${status.emoji} ${symbol}: ${status.key} (unverändert)`);
    }
  }

  const pushCount = results.filter(r => r.changed).length;
  console.log(`[check-alerts] Fertig: ${pushCount}/${results.length} Alerts ausgelöst`);

  // Phase 3: neuen Zustand im Blob speichern
  // const newState = Object.fromEntries(results.map(r => [r.id, r.status]));
  // await saveStatusBlob(newState);

  return { statusCode: 200, body: JSON.stringify({ alerts: pushCount, results }) };
};
