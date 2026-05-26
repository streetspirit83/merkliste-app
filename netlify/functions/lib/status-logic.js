/**
 * status-logic.js — Pure functions shared between browser (app.js) and
 * serverless (check-alerts.js). ES module, no side-effects, no DOM, no Store.
 */

/* ── Alert metadata ─────────────────────────────────────────────────── */

export const ALERT_NO_THRESHOLD = new Set([
  "ma20_below", "ma50_below", "ma200_below",
  "macd_bullish", "macd_bearish",
  "reversal_up_short", "reversal_down_short",
  "reversal_up_long", "reversal_down_long",
]);

export const ALERT_DEFAULT_DIR = {
  price_below:         "buy",   price_above:         "sell",
  rsi_below:           "buy",   rsi_above:           "sell",
  ma20_below:          "buy",   ma50_below:          "buy",   ma200_below: "buy",
  ma_below_pct:        "buy",   ma_above_pct:        "sell",
  macd_bullish:        "buy",   macd_bearish:        "sell",
  reversal_up_short:   "buy",   reversal_down_short: "sell",
  reversal_up_long:    "buy",   reversal_down_long:  "sell",
  vol_spike:           "watch",
  perf_below:          "sell",
  perf_above:          "sell",
};

export function alertDir(a) {
  return a.dir || a.nk_side || ALERT_DEFAULT_DIR[a.type] || "watch";
}

/* ── Alert evaluation ───────────────────────────────────────────────── */

export function evalAlert(alert, q) {
  if (!alert) return false;
  const noTh = ALERT_NO_THRESHOLD.has(alert.type);
  if (!noTh && alert.threshold == null) return false;
  const prev = q._prev || null;
  switch (alert.type) {
    case "price_below":  return q.price != null && q.price <= alert.threshold;
    case "price_above":  return q.price != null && q.price >= alert.threshold;
    case "rsi_above":    return q.rsi   != null && q.rsi   >= alert.threshold;
    case "rsi_below":    return q.rsi   != null && q.rsi   <= alert.threshold;
    case "ma20_below":   return q.price != null && q.ma20  != null && q.price <= q.ma20;
    case "ma50_below":   return q.price != null && q.ma50  != null && q.price <= q.ma50;
    case "ma200_below":  return q.price != null && q.ma200 != null && q.price <= q.ma200;
    case "macd_bullish": return q.macd_histogram != null && q.macd_histogram > 0;
    case "macd_bearish": return q.macd_histogram != null && q.macd_histogram < 0;
    case "ma_below_pct": { const mv = alert.ma ? q[alert.ma] : null; return mv != null && q.price != null && alert.threshold != null && q.price <= +(mv * (1 - alert.threshold / 100)).toFixed(4); }
    case "ma_above_pct": { const mv = alert.ma ? q[alert.ma] : null; return mv != null && q.price != null && alert.threshold != null && q.price >= +(mv * (1 + alert.threshold / 100)).toFixed(4); }
    case "reversal_up_short":
      return !!(prev && prev.macd_histogram != null && q.macd_histogram != null
        && prev.macd_histogram <= 0 && q.macd_histogram > 0);
    case "reversal_down_short":
      return !!(prev && prev.macd_histogram != null && q.macd_histogram != null
        && prev.macd_histogram >= 0 && q.macd_histogram < 0);
    case "reversal_up_long":
      return !!(prev && prev.price != null && prev.ma200 != null && q.price != null && q.ma200 != null
        && prev.price <= prev.ma200 && q.price > q.ma200);
    case "reversal_down_long":
      return !!(prev && prev.price != null && prev.ma200 != null && q.price != null && q.ma200 != null
        && prev.price >= prev.ma200 && q.price < q.ma200);
    case "vol_spike":
      return q.volume != null && q.avg_volume != null && q.avg_volume > 0
        && q.volume >= alert.threshold * q.avg_volume;
    case "perf_below":
      return q._perf_pct != null && alert.threshold != null
        && q._perf_pct <= -Math.abs(alert.threshold);
    case "perf_above":
      return q._perf_pct != null && alert.threshold != null
        && q._perf_pct >= Math.abs(alert.threshold);
    default: return false;
  }
}

/* Evaluate all alerts on a ticker respecting AND-groups.
   Returns alerts array with _trig set, plus summary booleans. */
export function evaluateAlerts(rawAlerts, q) {
  const groupResults = new Map();
  rawAlerts.forEach(a => {
    if (!a.group) return;
    const cur = groupResults.get(a.group);
    const trig = evalAlert(a, q);
    groupResults.set(a.group, cur == null ? trig : cur && trig);
  });
  const alerts = rawAlerts.map(a => ({
    ...a,
    _trig: a.group ? !!groupResults.get(a.group) : evalAlert(a, q)
  }));
  const alert_triggered = alerts.some(a => a._trig);
  const trigDirs = alerts.filter(a => a._trig).map(alertDir);
  const alert_triggered_dir = trigDirs.includes("sell") ? "sell"
    : trigDirs.includes("buy") ? "buy"
    : trigDirs.length ? "watch" : null;
  return { alerts, alert_triggered, alert_triggered_dir };
}

/* ── Status computation ─────────────────────────────────────────────── */

const MOMENTUM_POS = new Set(["macd_bullish", "reversal_up_short", "reversal_up_long"]);
const MOMENTUM_NEG = new Set(["macd_bearish", "reversal_down_short", "reversal_down_long"]);
const KURSZIEL_TYPES = new Set(["perf_above"]);

export const STATUS_MAP = {
  stop_loss:    { emoji: "🛑", label: "Stop-Loss",          pushColor: "red"    },
  verkauf:      { emoji: "↘",  label: "Verkauf",             pushColor: "orange" },
  momentum_neg: { emoji: "🔴", label: "Momentum negativ",    pushColor: "orange" },
  kauf:         { emoji: "💵", label: "Kauf",                pushColor: "green"  },
  momentum_pos: { emoji: "🟢", label: "Momentum positiv",    pushColor: "green"  },
  kursziel:     { emoji: "💰", label: "Kursziel",            pushColor: "green"  },
  halten:       { emoji: "—",  label: "Halten",              pushColor: null     },
};

/**
 * Compute the dominant status for a ticker.
 * @param {object} ticker    — full ticker object with ticker.user.alerts + ticker.quotes
 * @param {object} [enrichedQ] — optional enriched quotes (e.g. with _perf_pct injected)
 * @returns {{ key: string, emoji: string, label: string, pushColor: string|null }}
 */
export function computeStatus(ticker, enrichedQ) {
  const q   = enrichedQ || ticker.quotes || {};
  const raw = ticker.user?.alerts || [];
  const { alerts } = evaluateAlerts(raw, q);
  const trig = alerts.filter(a => a._trig);

  // 1. price_below + dir=sell → Stop-Loss
  if (trig.some(a => a.type === "price_below" && alertDir(a) === "sell"))
    return { key: "stop_loss", ...STATUS_MAP.stop_loss };

  // 2. price_above / perf_above + dir=sell → Kursziel
  if (trig.some(a => KURSZIEL_TYPES.has(a.type) && alertDir(a) === "sell"))
    return { key: "kursziel", ...STATUS_MAP.kursziel };

  // 3. Any other triggered sell-direction alert (non-momentum)
  if (trig.some(a => alertDir(a) === "sell" && !MOMENTUM_NEG.has(a.type)))
    return { key: "verkauf", ...STATUS_MAP.verkauf };

  // 4. Momentum negativ
  if (trig.some(a => MOMENTUM_NEG.has(a.type)))
    return { key: "momentum_neg", ...STATUS_MAP.momentum_neg };

  // 5. Any triggered buy-direction alert (non-momentum)
  if (trig.some(a => alertDir(a) === "buy" && !MOMENTUM_POS.has(a.type)))
    return { key: "kauf", ...STATUS_MAP.kauf };

  // 6. Momentum positiv
  if (trig.some(a => MOMENTUM_POS.has(a.type)))
    return { key: "momentum_pos", ...STATUS_MAP.momentum_pos };

  return { key: "halten", ...STATUS_MAP.halten };
}
