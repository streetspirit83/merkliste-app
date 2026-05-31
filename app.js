import { ALERT_NO_THRESHOLD, ALERT_DEFAULT_DIR, alertDir, evalAlert, evaluateAlerts, computeStatus, STATUS_MAP, MOMENTUM_POS, MOMENTUM_NEG }
  from './netlify/functions/lib/status-logic.js';

/* Lucide-Icon je Status-Schlüssel (nur Browser) */
const STATUS_LUCIDE = {
  stop_loss:    "ban",
  kursziel:     "target",
  verkauf:      "trending-down",
  momentum_neg: "arrow-down-right",
  kauf:         "trending-up",
  momentum_pos: "arrow-up-right",
};

/* ════════════════════════════════════════════════════
   SECTION 1 — CONFIG
   ════════════════════════════════════════════════════ */
const CONFIG = {
  storageKey: "merkliste.state.v1",
  api: {
    twelveData: { baseUrl: "https://api.twelvedata.com", key: "" },
    yahoo:      { endpoint: "/.netlify/functions/yahoo-quote" }
  },
  blob: { endpoint: "/.netlify/functions/blob" },
  discovery: { endpoint: "/.netlify/functions/discovery-import" },
  defaults: {
    view:   "cards",       // "cards" | "table"
    bucket: "portfolio",   // "portfolio" | "watchlist" | "neutral"
    nkPct:  30
  }
};

/* ════════════════════════════════════════════════════
   SECTION 2 — SCHEMA A (stamm / user / quotes / calculations)
   ════════════════════════════════════════════════════ */

/* helper: build empty quote+calc shells so render-functions never see undefined */
const emptyQuotes = () => ({
  price: null, currency_returned: null, day_change_pct: null, month_change_pct: null,
  volume: null, avg_volume: null, pos_52whigh: null, pos_52low: null, high_52w: null, low_52w: null,
  rsi: null, macd: null, macd_signal: null, macd_histogram: null,
  ma20: null, ma20_delta_pct: null,
  ma50: null, ma50_delta_pct: null,
  ma200: null, ma200_delta_pct: null,
  last7d: null,
  ts: null, _source: null, _api_meta: null
});
const emptyCalcs = () => ({
  trends: {
    sentiment: null, sentiment_score: null, sentiment_breakdown: null,
    trend_strength: null,
    performance_pct: null, performance_abs: null,
    position_value: null, position_pl_abs: null,
    alert_triggered: false, calculated_at: null
  },
  signals: null, risk_management: null, smart_alerts: null
});

const BENCHMARK_DEFAULTS = [
  { symbol: "^GDAXI", td_symbol: "GDAXI", label: "DAX", price: null, day_change_pct: null, week_change_pct: null, month_change_pct: null, closes: [] },
  { symbol: "^GSPC",  td_symbol: "SPX",   label: "S&P", price: null, day_change_pct: null, week_change_pct: null, month_change_pct: null, closes: [] },
  { symbol: "^IXIC",  td_symbol: "IXIC",  label: "NDX", price: null, day_change_pct: null, week_change_pct: null, month_change_pct: null, closes: [] }
];

const Schema = {
  tickers: [],
  benchmarks: BENCHMARK_DEFAULTS.map(b => ({ ...b })),
  ui: {
    view:        CONFIG.defaults.view,
    bucket:      CONFIG.defaults.bucket,
    activeView:  "screener",
    menuOpen:    false,
    sortKey:     "day_change_pct",
    sortDir:     "desc",
    triggeredOnly: false,
    filterAsset:   "",           // "" | "ETF" | "Aktie" etc.
    filterTag:     "",           // "" | tag string
    selected:    [],          // array of ticker ids
    editingId:   null,
    nachkaufId:  null
  },
  config: { twelveDataKey: CONFIG.api.twelveData.key, eur_usd: null, strategy_targets: { long: 50, swing: 30, breakout: 20 } }
};

const Store = {
  state: structuredClone(Schema),
  load() {
    try {
      const raw = localStorage.getItem(CONFIG.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        // merge defensively — schema changes won't blow up old saves
        if (Array.isArray(parsed.tickers)) this.state.tickers = parsed.tickers;
        if (Array.isArray(parsed.benchmarks)) {
          parsed.benchmarks.forEach(b => {
            const def = this.state.benchmarks.find(d => d.symbol === b.symbol);
            if (def) Object.assign(def, b);
          });
          // backfill td_symbol for saved data that predates this field
          this.state.benchmarks.forEach((b, i) => {
            if (!b.td_symbol) b.td_symbol = BENCHMARK_DEFAULTS[i]?.td_symbol || "";
          });
        }
        if (parsed.ui) Object.assign(this.state.ui, parsed.ui);
        if (parsed.config) Object.assign(this.state.config, parsed.config);
        // reset transient selection
        this.state.ui.selected = [];
        this.state.ui.editingId = null;
        this.state.ui.nachkaufId = null;
      }
    } catch (err) { console.warn("[store] load failed", err); }
    return this.state;
  },
  save() {
    try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(this.state)); }
    catch (err) { console.warn("[store] save failed", err); }
  },
  patchUi(patch) { Object.assign(this.state.ui, patch); this.save(); },
  patchConfig(patch) { Object.assign(this.state.config, patch); this.save(); },
  byId(id) { return this.state.tickers.find(t => t.id === id); },
  upsert(ticker) {
    const i = this.state.tickers.findIndex(t => t.id === ticker.id);
    if (i >= 0) this.state.tickers[i] = ticker;
    else this.state.tickers.push(ticker);
    this.save();
  },
  remove(id) {
    this.state.tickers = this.state.tickers.filter(t => t.id !== id);
    this.save();
  }
};

/* ────────── eff() helper ──────────
   Schema A: user fields override stamm fields for SOME narrative fields.
   For data-only fields (symbol, exchange…) eff falls back to stamm.
   For numeric/quote fields eff just returns the quotes value. */
function eff(t, field) {
  if (!t) return null;
  // user-narrative fields that can override stamm
  const overridable = ["core_business","trend_reason","recent_news","next_catalysts","why_not"];
  if (overridable.includes(field)) {
    if (t.user && t.user[field] != null) return t.user[field];
    return t.stamm ? t.stamm[field] : null;
  }
  // stamm direct
  if (t.stamm && field in t.stamm) return t.stamm[field];
  // user direct
  if (t.user && field in t.user) return t.user[field];
  // quotes direct
  if (t.quotes && field in t.quotes) return t.quotes[field];
  // calc nested
  if (t.calculations && t.calculations.trends && field in t.calculations.trends) return t.calculations.trends[field];
  return null;
}
window.eff = eff; // prompts.js (classic script) needs eff as global

/* ════════════════════════════════════════════════════
   SECTION 3 — API ADAPTERS  (Twelve Data only)
   ════════════════════════════════════════════════════ */
const API = {
  _key() {
    const k = Store.state.config.twelveDataKey;
    if (!k) throw new Error("Kein Twelve Data API Key gesetzt — Config öffnen");
    return k;
  },

  /* single-call: uses mic_code (per Project-Description) for unique symbol resolution */
  async tdQuoteSingle(t) {
    const key = API._key();
    const sym = t.stamm.twelvedata_symbol || t.stamm.symbol;
    const mic = t.stamm.twelvedata_mic_code;
    const url = new URL(`${CONFIG.api.twelveData.baseUrl}/quote`);
    url.searchParams.set("symbol", sym);
    if (mic) url.searchParams.set("mic_code", mic);
    url.searchParams.set("apikey", key);
    const res = await fetch(url.toString());
    const json = await res.json();
    if (json.status === "error" || json.code) throw new Error(json.message || `TD error for ${sym}`);
    return API._tdMapQuote(json);
  },

  /* batch: SYMBOL:EXCHANGE format; tolerates per-symbol errors */
  async tdQuoteBatch(tickers) {
    const key = API._key();
    if (!tickers.length) return {};
    if (tickers.length === 1) {
      const t = tickers[0];
      const sym = t.stamm.twelvedata_symbol || t.stamm.symbol;
      try {
        const q = await API.tdQuoteSingle(t);
        return { [sym]: q };
      } catch (err) {
        return { [sym]: { _error: err.message } };
      }
    }
    const symbolStrings = tickers.map(t => {
      const sym  = t.stamm.twelvedata_symbol || t.stamm.symbol;
      const exch = t.stamm.twelvedata_exchange || t.stamm.exchange;
      return exch ? `${sym}:${exch}` : sym;
    });
    const fetchChunk = async (chunkSyms) => {
      const url = new URL(`${CONFIG.api.twelveData.baseUrl}/quote`);
      url.searchParams.set("symbol", chunkSyms.join(","));
      url.searchParams.set("apikey", key);
      const res = await fetch(url.toString());
      const json = await res.json();
      if (json.status === "error" && !json.symbol && Object.keys(json).every(k => k === "status" || k === "code" || k === "message")) {
        throw new Error(json.message || "TD batch error");
      }
      const out = {};
      if (json.symbol && json.close != null) {
        out[json.symbol] = API._tdMapQuote(json);
        out[chunkSyms[0]] = out[json.symbol];
        return out;
      }
      for (const [k, v] of Object.entries(json)) {
        if (!v || typeof v !== "object") continue;
        const k1 = k, k2 = k.split(":")[0];
        if (v.status === "error" || v.code) { const e = v.message || "TD error"; out[k1] = { _error: e }; out[k2] = out[k1]; }
        else if (v.close != null || v.price != null) { out[k1] = API._tdMapQuote(v); out[k2] = out[k1]; }
      }
      return out;
    };
    const out = {};
    for (let i = 0; i < symbolStrings.length; i += TdRL.MAX) {
      const chunk = symbolStrings.slice(i, i + TdRL.MAX);
      await TdRL.throttle(chunk.length, `TD ${Math.min(i + TdRL.MAX, symbolStrings.length)}/${symbolStrings.length}`);
      Object.assign(out, await fetchChunk(chunk));
    }
    return out;
  },

  /* symbol_search: returns normalized matches with mic_code, exchange, currency */
  async tdSymbolSearch(query) {
    const key = API._key();
    const url = new URL(`${CONFIG.api.twelveData.baseUrl}/symbol_search`);
    url.searchParams.set("symbol", query);
    url.searchParams.set("outputsize", "20");
    url.searchParams.set("apikey", key);
    const res = await fetch(url.toString());
    const json = await res.json();
    if (json.status === "error" || json.code) throw new Error(json.message || "Symbol search failed");
    return (json.data || []).map(d => ({
      symbol: d.symbol,
      name: d.instrument_name,
      exchange: d.exchange,
      mic_code: d.mic_code,
      country: d.country,
      currency: d.currency,
      type: d.instrument_type
    }));
  },

  /* normalize TD time_series response into { closes:[newest..oldest], meta } — kept for internal use */
  _tdMapQuote(j) {
    const num = v => (v == null || v === "") ? null : +v;
    return {
      price: num(j.close ?? j.price),
      currency_returned: j.currency || null,
      day_change_pct: num(j.percent_change),
      volume: num(j.volume),
      avg_volume: num(j.average_volume),
      pos_52whigh: j.fifty_two_week ? num(j.fifty_two_week.high_change_percent) : null,
      pos_52low:   j.fifty_two_week ? num(j.fifty_two_week.low_change_percent)  : null,
      high_52w:    j.fifty_two_week ? num(j.fifty_two_week.high) : null,
      low_52w:     j.fifty_two_week ? num(j.fifty_two_week.low)  : null,
      ts: Date.now(),
      _source: "twelvedata",
      _api_meta: {
        symbol_returned: j.symbol, exchange_returned: j.exchange,
        mic_code_returned: j.mic_code, currency_returned: j.currency,
        provider: "twelvedata"
      }
    };
  },

  /* public — TD merge keeps existing MAs/RSI since /quote doesn't deliver them */
  async refreshOne(t) {
    const q = await API.tdQuoteSingle(t);
    t.quotes._prev = { price: t.quotes.price, macd_histogram: t.quotes.macd_histogram, ma200: t.quotes.ma200 };
    Object.assign(t.quotes, q);
  },
  /* Returns { ok: number, failed: [{symbol, error}] } so caller can report partials.
     Quick refresh: Quote only; falls back to Yahoo (no history) for failed entries. */
  async refreshMany(tickers) {
    if (!tickers.length) return { ok: 0, failed: [], updatedIds: [] };
    const map = await API.tdQuoteBatch(tickers);
    let ok = 0; const failed = []; const updatedIds = [];
    for (const t of tickers) {
      const sym  = t.stamm.twelvedata_symbol || t.stamm.symbol;
      const exch = t.stamm.twelvedata_exchange || t.stamm.exchange;
      const entry = map[sym] || (exch && map[`${sym}:${exch}`]);
      if (!entry)            { failed.push({ symbol: sym, error: "Kein Ergebnis", ticker: t }); continue; }
      if (entry._error)      { failed.push({ symbol: sym, error: entry._error,    ticker: t }); continue; }
      t.quotes._prev = { price: t.quotes.price, macd_histogram: t.quotes.macd_histogram, ma200: t.quotes.ma200 };
      Object.assign(t.quotes, entry);
      ok++; updatedIds.push(t.id);
    }
    /* Yahoo fallback (quote only) for failed TD entries */
    if (failed.length) {
      const retryable = failed.filter(f => f.ticker);
      const yMap = await API.yahooBatch(retryable.map(f => f.ticker), false);
      const recovered = new Set();
      for (const r of retryable) {
        const y = yMap[r.symbol];
        if (y && !y._error && y.quote) {
          Object.assign(r.ticker.quotes, y.quote);
          r.ticker.quotes._source = "yahoo";
          recovered.add(r.symbol);
        }
      }
      const remaining = failed.filter(f => !recovered.has(f.symbol));
      return { ok: ok + recovered.size, failed: remaining.map(f => ({ symbol: f.symbol, error: f.error })), updatedIds };
    }
    return { ok, failed: [], updatedIds };
  },

  /* ───── time_series for MA/RSI calculation (Full-Refresh path) ───── */
  /* Single-symbol path: uses mic_code for unambiguous resolution */
  async tdTimeSeriesSingle(t, outputsize = 210) {
    const key = API._key();
    const sym = t.stamm.twelvedata_symbol || t.stamm.symbol;
    const mic = t.stamm.twelvedata_mic_code;
    const url = new URL(`${CONFIG.api.twelveData.baseUrl}/time_series`);
    url.searchParams.set("symbol", sym);
    if (mic) url.searchParams.set("mic_code", mic);
    url.searchParams.set("interval", "1day");
    url.searchParams.set("outputsize", String(outputsize));
    url.searchParams.set("order", "ASC");
    url.searchParams.set("apikey", key);
    const res = await fetch(url.toString());
    const json = await res.json();
    if (json.status === "error" || json.code) throw new Error(json.message || `TD time_series error for ${sym}`);
    /* values: [{datetime, open, high, low, close, volume}, ...] in ascending order */
    return (json.values || []).map(v => +v.close).filter(n => !isNaN(n));
  },

  /* Batch path: comma-separated symbols. Returns { sym: closes[] | {_error} } */
  async tdTimeSeriesBatch(tickers, outputsize = 210) {
    const key = API._key();
    if (!tickers.length) return {};
    if (tickers.length === 1) {
      const t = tickers[0];
      const sym = t.stamm.twelvedata_symbol || t.stamm.symbol;
      try { return { [sym]: await API.tdTimeSeriesSingle(t, outputsize) }; }
      catch (err) { return { [sym]: { _error: err.message } }; }
    }
    const symbolStrings = tickers.map(t => {
      const sym  = t.stamm.twelvedata_symbol || t.stamm.symbol;
      const exch = t.stamm.twelvedata_exchange || t.stamm.exchange;
      return exch ? `${sym}:${exch}` : sym;
    });
    const fetchChunk = async (chunkSyms) => {
      const url = new URL(`${CONFIG.api.twelveData.baseUrl}/time_series`);
      url.searchParams.set("symbol", chunkSyms.join(","));
      url.searchParams.set("interval", "1day");
      url.searchParams.set("outputsize", String(outputsize));
      url.searchParams.set("order", "ASC");
      url.searchParams.set("apikey", key);
      const res = await fetch(url.toString());
      const json = await res.json();
      if (json.status === "error" && !json.values && !json.meta &&
          Object.keys(json).every(k => k === "status" || k === "code" || k === "message")) {
        throw new Error(json.message || "TD time_series batch error");
      }
      const out = {};
      if (json.values && json.meta) {
        const sym = json.meta.symbol;
        out[sym] = json.values.map(v => +v.close).filter(n => !isNaN(n));
        out[chunkSyms[0]] = out[sym];
        return out;
      }
      for (const [k, v] of Object.entries(json)) {
        if (!v || typeof v !== "object") continue;
        const k1 = k, k2 = k.split(":")[0];
        if (v.status === "error" || v.code) { out[k1] = { _error: v.message || "TD error" }; out[k2] = out[k1]; }
        else if (Array.isArray(v.values)) { out[k1] = v.values.map(x => +x.close).filter(n => !isNaN(n)); out[k2] = out[k1]; }
      }
      return out;
    };
    const out = {};
    for (let i = 0; i < symbolStrings.length; i += TdRL.MAX) {
      const chunk = symbolStrings.slice(i, i + TdRL.MAX);
      await TdRL.throttle(chunk.length, `TD-TS ${Math.min(i + TdRL.MAX, symbolStrings.length)}/${symbolStrings.length}`);
      Object.assign(out, await fetchChunk(chunk));
    }
    return out;
  },

  /* Full refresh = quote + time_series → computes MAs/RSI from closes */
  async refreshFullMany(tickers) {
    if (!tickers.length) return { ok: 0, failed: [], updatedIds: [] };
    /* run both in parallel */
    const [qMap, tsMap] = await Promise.all([
      API.tdQuoteBatch(tickers),
      API.tdTimeSeriesBatch(tickers, 210)
    ]);
    let ok = 0; const failed = []; const updatedIds = [];
    for (const t of tickers) {
      const sym  = t.stamm.twelvedata_symbol || t.stamm.symbol;
      const exch = t.stamm.twelvedata_exchange || t.stamm.exchange;
      const qEntry  = qMap[sym]  || (exch && qMap[`${sym}:${exch}`]);
      const tsEntry = tsMap[sym] || (exch && tsMap[`${sym}:${exch}`]);

      /* prefer time_series for current price if quote missing; else use quote */
      if (qEntry && !qEntry._error) {
        t.quotes._prev = { price: t.quotes.price, macd_histogram: t.quotes.macd_histogram, ma200: t.quotes.ma200 };
        Object.assign(t.quotes, qEntry);
      }
      if (tsEntry && !tsEntry._error && Array.isArray(tsEntry) && tsEntry.length) {
        const indicators = Calc.indicatorsFromCloses(tsEntry, t.quotes.price);
        Object.assign(t.quotes, indicators);
        t.quotes.last7d = tsEntry.slice(-7); // ascending: oldest→newest
      }

      const qOk  = qEntry  && !qEntry._error;
      const tsOk = tsEntry && !tsEntry._error && Array.isArray(tsEntry) && tsEntry.length;
      if (!qOk && !tsOk) {
        const err = (qEntry && qEntry._error) || (tsEntry && tsEntry._error) || "Kein Ergebnis";
        failed.push({ symbol: sym, error: err, ticker: t, needsHist: true });
      } else if (!tsOk) {
        failed.push({ symbol: sym, error: "Historie fehlt: " + ((tsEntry && tsEntry._error) || "leer"), ticker: t, needsHist: true });
        ok++; updatedIds.push(t.id);
      } else {
        ok++; updatedIds.push(t.id);
      }
    }

    /* Yahoo fallback for failed entries — transparent retry via /.netlify/functions/yahoo-quote */
    const retryable = failed.filter(f => f.ticker);
    if (retryable.length) {
      const yResults = await API.yahooBatch(retryable.map(f => f.ticker), true);
      const recoveredFully = new Set();
      const recoveredHist  = new Set();
      for (const r of retryable) {
        const y = yResults[r.symbol];
        if (!y || y._error) continue;
        const wasFullyFailed = r.needsHist && !r.tsOnly;
        Object.assign(r.ticker.quotes, y.quote || {});
        if (Array.isArray(y.closes) && y.closes.length) {
          const indicators = Calc.indicatorsFromCloses(y.closes, r.ticker.quotes.price);
          Object.assign(r.ticker.quotes, indicators);
          // Yahoo closes are descending; reverse to ascending for sparkline
          r.ticker.quotes.last7d = y.closes.slice(-7);
          recoveredHist.add(r.symbol);
        }
        r.ticker.quotes._source = "yahoo";
        if (wasFullyFailed) recoveredFully.add(r.symbol);
      }
      /* drop fully-recovered from failed; bump ok by count of recovered-fully */
      const remaining = failed.filter(f => !(recoveredFully.has(f.symbol) || recoveredHist.has(f.symbol)));
      return { ok: ok + recoveredFully.size, failed: remaining.map(f => ({ symbol: f.symbol, error: f.error })), updatedIds };
    }
    return { ok, failed: failed.map(f => ({ symbol: f.symbol, error: f.error })), updatedIds };
  },

  /* ═══════ Yahoo Finance fallback via Netlify Function ═══════ */
  /* yahooQuote(t, withHistory): returns { quote, closes? } | { _error } */
  async yahooQuote(t, withHistory = false) {
    const symbol = t.stamm.yahoo_symbol || API._guessYahooSymbol(t);
    if (!symbol) return { _error: "Kein Yahoo-Symbol" };
    const url = new URL(`${CONFIG.api.yahoo.endpoint}`, location.origin);
    url.searchParams.set("symbol", symbol);
    if (withHistory) url.searchParams.set("history", "1");
    try {
      const res = await fetch(url.toString());
      if (!res.ok) return { _error: `Yahoo HTTP ${res.status}` };
      const json = await res.json();
      if (json.error) return { _error: json.error };
      return API._mapYahoo(json, t);
    } catch (err) {
      return { _error: err.message };
    }
  },

  /* yahooBatch: parallel single-symbol calls (Yahoo has no real batch endpoint) */
  async yahooBatch(tickers, withHistory = false) {
    const out = {};
    const results = await Promise.allSettled(tickers.map(t => API.yahooQuote(t, withHistory)));
    tickers.forEach((t, i) => {
      const sym = t.stamm.twelvedata_symbol || t.stamm.symbol;
      const r = results[i];
      out[sym] = r.status === "fulfilled" ? r.value : { _error: r.reason?.message || "Yahoo-Fehler" };
    });
    return out;
  },

  /* Fetch benchmark indices via Twelve Data.
     Requires a TD API key — no Yahoo fallback (proxy not available locally). */
  /* Fetch benchmark indices via Yahoo proxy (always with history for trend + 1W/1M).
     Manual-only — not called automatically on ticker refresh. Requires Netlify. */
  async fetchBenchmarks() {
    const benchmarks = Store.state.benchmarks;
    const num = v => (v == null || v === "") ? null : +v;
    const results = await Promise.allSettled(benchmarks.map(b => {
      const url = new URL(CONFIG.api.yahoo.endpoint, location.origin);
      url.searchParams.set("symbol",  b.symbol);
      url.searchParams.set("history", "1");
      return fetch(url.toString()).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
    }));
    let anyOk = false;
    results.forEach((r, i) => {
      if (r.status !== "fulfilled" || r.value.error) return;
      const j = r.value;
      const q = j.quote || j.meta || {};
      benchmarks[i].price          = num(q.regularMarketPrice ?? q.price);
      benchmarks[i].day_change_pct = num(q.regularMarketChangePercent ?? q.percent_change);
      if (Array.isArray(j.closes) && j.closes.length > 0) {
        benchmarks[i].closes = j.closes.filter(n => n != null && !isNaN(+n)).map(Number);
        const c = benchmarks[i].closes;
        const last = c[c.length - 1];
        benchmarks[i].week_change_pct  = c.length >= 6  ? +((last - c[c.length - 6])  / c[c.length - 6]  * 100).toFixed(2) : null;
        benchmarks[i].month_change_pct = c.length >= 22 ? +((last - c[c.length - 22]) / c[c.length - 22] * 100).toFixed(2) : null;
      }
      anyOk = true;
    });
    Store.save();
    renderBenchBar();
    if (!anyOk) toast("Benchmarks: Kein Ergebnis (Netlify erforderlich)", "neg");
  },

  /* Heuristic: if user only set TD fields, derive Yahoo symbol from exchange */
  _guessYahooSymbol(t) {
    const s = t.stamm;
    if (s.yahoo_symbol) return s.yahoo_symbol;
    const base = s.twelvedata_symbol || s.symbol;
    if (!base) return null;
    const mic = (s.twelvedata_mic_code || "").toUpperCase();
    const exch = (s.twelvedata_exchange || s.exchange || "").toUpperCase();
    /* Yahoo suffix mapping based on MIC */
    const micMap = {
      "XETR": ".DE", "XFRA": ".F", "XAMS": ".AS", "XSWX": ".SW", "XPAR": ".PA",
      "XLON": ".L", "XSTO": ".ST", "XHEL": ".HE", "XCSE": ".CO", "XOSL": ".OL",
      "XMIL": ".MI", "XMAD": ".MC", "XBRU": ".BR", "XLIS": ".LS", "XWAR": ".WA",
      "XNAS": "", "XNYS": "", "ARCX": "", "BATS": ""
    };
    if (mic in micMap) return base + micMap[mic];
    /* fallback by exchange name */
    if (exch.includes("XETRA") || exch.includes("FRANKFURT")) return base + ".DE";
    if (exch.includes("STOCKHOLM"))                            return base + ".ST";
    if (exch.includes("LONDON"))                               return base + ".L";
    if (exch.includes("AMSTERDAM"))                            return base + ".AS";
    if (exch.includes("PARIS"))                                return base + ".PA";
    if (exch.includes("MILAN"))                                return base + ".MI";
    if (exch.includes("MADRID"))                               return base + ".MC";
    if (exch === "NASDAQ" || exch === "NYSE" || exch.includes("ARCA")) return base;
    return base;
  },

  /* normalize Yahoo proxy response → quote+closes shape compatible with our quotes block */
  _mapYahoo(j, t) {
    const num = v => (v == null || v === "") ? null : +v;
    const q = j.quote || j.meta || {};
    const quote = {
      price: num(q.regularMarketPrice ?? q.price),
      currency_returned: q.currency || null,
      day_change_pct: num(q.regularMarketChangePercent ?? q.percent_change),
      volume: num(q.regularMarketVolume ?? q.volume),
      avg_volume: num(q.averageDailyVolume3Month ?? q.avg_volume),
      pos_52whigh: num(q.fiftyTwoWeekHighChangePercent),
      pos_52low:   num(q.fiftyTwoWeekLowChangePercent),
      high_52w:    num(q.fiftyTwoWeekHigh),
      low_52w:     num(q.fiftyTwoWeekLow),
      ts: Date.now(),
      _source: "yahoo",
      _api_meta: {
        symbol_returned: q.symbol, exchange_returned: q.fullExchangeName,
        provider: "yahoo"
      }
    };
    const closes = Array.isArray(j.closes) ? j.closes.filter(n => n != null && !isNaN(+n)).map(n => +n) : null;
    return { quote, closes };
  },

  async fetchEurUsd() {
    const k = Store.state.config.twelveDataKey;
    if (!k) return;
    try {
      const url = new URL(`${CONFIG.api.twelveData.baseUrl}/exchange_rate`);
      url.searchParams.set("symbol", "EUR/USD");
      url.searchParams.set("apikey", k);
      const r = await fetch(url.toString());
      if (!r.ok) return;
      const j = await r.json();
      const rate = j.rate ? +j.rate : null;
      if (rate && rate > 0) Store.patchConfig({ eur_usd: rate });
    } catch { /* silent — conversion falls back to raw price */ }
  }
};

/* ════════════════════════════════════════════════════
   SECTION 4 — BUSINESS LOGIC (calculations + alerts)
   ════════════════════════════════════════════════════ */
const Calc = {
  /* SMA, RSI, MACD from close-series (ascending: oldest → newest).
     If called with descending data (TD default), pass `descending: true` for auto-reverse.
     current price comes from quote endpoint or last close */
  indicatorsFromCloses(closesIn, currentPrice = null, descending = false) {
    if (!Array.isArray(closesIn) || closesIn.length < 2) return {};
    const closes = descending ? [...closesIn].reverse() : closesIn;
    const last = currentPrice != null ? currentPrice : closes[closes.length - 1];
    const sma = (arr, n) => {
      if (arr.length < n) return null;
      const slice = arr.slice(-n);
      return +(slice.reduce((a, b) => a + b, 0) / n).toFixed(2);
    };
    const ma20  = sma(closes, 20);
    const ma50  = sma(closes, 50);
    const ma200 = sma(closes, 200);
    const delta = (price, m) => (m == null || price == null) ? null : +(((price - m) / m) * 100).toFixed(2);
    /* RSI(14) with Wilder smoothing */
    let rsi = null;
    if (closes.length > 14) {
      let gain = 0, loss = 0;
      for (let i = 1; i <= 14; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gain += d; else loss -= d;
      }
      let avgG = gain / 14, avgL = loss / 14;
      for (let i = 15; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        const g = d > 0 ? d : 0;
        const l = d < 0 ? -d : 0;
        avgG = (avgG * 13 + g) / 14;
        avgL = (avgL * 13 + l) / 14;
      }
      const rs = avgL === 0 ? 100 : avgG / avgL;
      rsi = +(100 - 100 / (1 + rs)).toFixed(2);
    }
    /* MACD(12,26,9): EMA12 - EMA26, signal = EMA9 of MACD line */
    let macd = null, macd_signal = null, macd_histogram = null;
    if (closes.length >= 26) {
      const ema = (arr, n) => {
        const k = 2 / (n + 1);
        let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
        const out = [e];
        for (let i = n; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
        return out;
      };
      const ema12 = ema(closes, 12);
      const ema26 = ema(closes, 26);
      /* align: ema12 is longer than ema26 by (26-12)=14 leading values */
      const off = ema12.length - ema26.length;
      const macdLine = ema26.map((v, i) => ema12[i + off] - v);
      if (macdLine.length >= 9) {
        const sig = ema(macdLine, 9);
        macd = +macdLine[macdLine.length - 1].toFixed(2);
        macd_signal = +sig[sig.length - 1].toFixed(2);
        macd_histogram = +(macd - macd_signal).toFixed(2);
      }
    }
    return {
      ma20, ma20_delta_pct:  delta(last, ma20),
      ma50, ma50_delta_pct:  delta(last, ma50),
      ma200, ma200_delta_pct: delta(last, ma200),
      rsi, macd, macd_signal, macd_histogram,
      month_change_pct: closes.length >= 22
        ? +((last - closes[closes.length - 22]) / closes[closes.length - 22] * 100).toFixed(2)
        : null
    };
  },

  /* sentiment_score is a blend of momentum/trend/macd/volume sub-scores
     each in [-1, +1]. Output also clamped to [-1, +1]. */
  sentiment(q) {
    const clamp = v => Math.max(-1, Math.min(1, v));
    const s_mom = q.day_change_pct == null ? 0 : clamp(q.day_change_pct / 5);
    const s_short = q.ma20_delta_pct  == null ? 0 : clamp(q.ma20_delta_pct  / 10);
    const s_mid   = q.ma50_delta_pct  == null ? 0 : clamp(q.ma50_delta_pct  / 15);
    const s_long  = q.ma200_delta_pct == null ? 0 : clamp(q.ma200_delta_pct / 25);
    const s_macd  = q.macd_histogram  == null ? 0 : clamp(q.macd_histogram  / 1.0);
    const s_vol   = (q.volume != null && q.avg_volume) ? clamp((q.volume / q.avg_volume - 1)) : 0;
    const score = clamp((s_mom + s_short + s_mid + s_long + s_macd + s_vol) / 6);
    const breakdown = { momentum:s_mom, trend_short:s_short, trend_mid:s_mid, trend_long:s_long, macd:s_macd, volume:s_vol };
    const sentiment = score > 0.2 ? "bullish" : score < -0.2 ? "bearish" : "neutral";
    const trend_strength = Math.abs(score) >= 0.4 ? "stark" : Math.abs(score) >= 0.15 ? "neutral" : "schwach";
    return { sentiment, sentiment_score: +score.toFixed(2), sentiment_breakdown: breakdown, trend_strength };
  },

  /* performance & position values from manual entry data */
  position(t) {
    const rawPrice = t.quotes.price;
    const ccy      = t.quotes.currency_returned || t.stamm?.currency;
    const rate     = Store.state.config.eur_usd;
    const price    = (ccy === "USD" && rate) ? +(rawPrice / rate).toFixed(4) : rawPrice;
    const entry    = t.user.entry_price_manual;
    const sh       = t.user.entry_shares;
    if (price == null || entry == null) return { performance_pct: null, performance_abs: null, position_value: null, position_pl_abs: null };
    const performance_abs = +(price - entry).toFixed(2);
    const performance_pct = +((performance_abs / entry) * 100).toFixed(2);
    const position_value  = sh != null ? +(price * sh).toFixed(2) : null;
    const position_pl_abs = sh != null ? +(performance_abs * sh).toFixed(2) : null;
    return { performance_pct, performance_abs, position_value, position_pl_abs };
  },

  /* evaluate one alert against current quotes → boolean trig (delegates to lib) */
  evalAlert(alert, q) { return evalAlert(alert, q); },

  /* recompute calculations block for ONE ticker */
  recompute(t) {
    const sent = Calc.sentiment(t.quotes);
    const pos  = Calc.position(t);
    // Convert price fields to display currency (EUR) so thresholds match what user sees
    const rate  = Store.state.config.eur_usd;
    const ccy   = t.quotes.currency_returned || t.stamm?.currency || "";
    const toEur = v => (ccy === "USD" && rate && v != null) ? +(v / rate).toFixed(4) : v;
    const eq = {
      ...t.quotes,
      price: toEur(t.quotes.price),
      ma20:  toEur(t.quotes.ma20),
      ma50:  toEur(t.quotes.ma50),
      ma200: toEur(t.quotes.ma200),
      _perf_pct: pos.performance_pct ?? null,
    };
    const { alerts, alert_triggered, alert_triggered_dir } =
      evaluateAlerts(t.user.alerts || [], eq);
    const status = computeStatus(t, eq);
    t.calculations = {
      trends: {
        sentiment: sent.sentiment,
        sentiment_score: sent.sentiment_score,
        sentiment_breakdown: sent.sentiment_breakdown,
        trend_strength: sent.trend_strength,
        ...pos,
        alert_triggered,
        alert_triggered_dir,
        status_key:   status.key,
        status_emoji: status.emoji,
        status_label: status.label,
        calculated_at: Date.now()
      },
      signals: null, risk_management: null,
      smart_alerts: alerts
    };
    return t;
  },

  recomputeAll() {
    Store.state.tickers.forEach(Calc.recompute);
    Store.save();
  }
};

/* ════════════════════════════════════════════════════
   FLATTEN — present Schema-A ticker as flat row for render
   ════════════════════════════════════════════════════ */
function flat(t) {
  const s = t.stamm, u = t.user, q = t.quotes;
  const c = (t.calculations && t.calculations.trends) || {};
  const rate     = Store.state.config.eur_usd;
  const rawCcy   = q.currency_returned || s.currency;
  const toEur    = v => (rawCcy === "USD" && rate && v != null) ? +(v / rate).toFixed(4) : v;
  const price    = toEur(q.price);
  const displayCcy = (rawCcy === "USD" && rate) ? "EUR" : rawCcy;
  return {
    id: t.id, _raw: t,
    symbol: s.symbol, name: s.name, exchange: s.exchange,
    asset_type: s.asset_type, sector: s.sector, sub_sector: s.sub_sector, market_cap_size: s.market_cap_size, currency: s.currency,
    tradingview_url: s.tradingview_url || null,
    stocktwits_url: s.stocktwits_url || `https://stocktwits.com/symbol/${s.symbol}`,
    bucket: u.bucket, priority: u.priority, notes: u.notes, tags: u.tags,
    entry_price_manual: u.entry_price_manual, entry_shares: u.entry_shares,
    alerts: u.alerts || [],
    price, currency_returned: displayCcy, day_change_pct: q.day_change_pct, month_change_pct: q.month_change_pct ?? null,
    volume: q.volume, avg_volume: q.avg_volume,
    pos_52whigh: q.pos_52whigh, pos_52low: q.pos_52low,
    high_52w: toEur(q.high_52w), low_52w: toEur(q.low_52w),
    rsi: q.rsi, macd: q.macd, macd_signal: q.macd_signal, macd_histogram: q.macd_histogram,
    ma20: toEur(q.ma20), ma20_delta_pct: q.ma20_delta_pct,
    ma50: toEur(q.ma50), ma50_delta_pct: q.ma50_delta_pct,
    ma200: toEur(q.ma200), ma200_delta_pct: q.ma200_delta_pct,
    last7d: q.last7d ? q.last7d.map(toEur) : null,
    ts: q.ts,
    sentiment_score: c.sentiment_score, trend_strength: c.trend_strength,
    performance_pct: c.performance_pct, performance_abs: c.performance_abs,
    position_value: c.position_value, position_pl_abs: c.position_pl_abs,
    alert_triggered: !!c.alert_triggered,
    alert_triggered_dir: c.alert_triggered_dir || null,
    status_key:   c.status_key   || "halten",
    status_emoji: c.status_emoji || "—",
    status_label: c.status_label || "Halten",
    smart_alerts: (t.calculations && t.calculations.smart_alerts) || []
  };
}

/* ════════════════════════════════════════════════════
   SECTION 5 — RENDER
   ════════════════════════════════════════════════════ */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const Render = {
  all() {
    this.viewMode();
    this.bucket();
    this.menu();
    this.bulkbar();
    this.filterBar();
    renderBenchBar();
    const av = Store.state.ui.activeView;
    if (av === "portfolio") {
      const activeTab = $(".pf-tab.is-active")?.dataset?.pftab || "perf";
      if (activeTab === "archive") renderArchiveView();
      else renderPortfolioPerf();
    } else if (av === "dashboard") {
      renderDashboard();
    } else if (av === "analyse") {
      renderAnalyse();
    }
  },
  viewMode() {
    const { view, activeView } = Store.state.ui;
    const inScreener  = activeView === "screener";
    const inPortfolio = activeView === "portfolio";
    const inDashboard = activeView === "dashboard";
    const inAnalyse   = activeView === "analyse";
    const showBench   = inScreener && view === "table";
    $("#btn-element-card-view") .setAttribute("aria-pressed", view === "cards");
    $("#btn-element-table-view").setAttribute("aria-pressed", view === "table");
    $("#subbar").hidden          = !inScreener;
    $("#filterbar").hidden       = !inScreener;
    $("#pfbar").hidden           = !inPortfolio;
    $("#benchbar").hidden        = !showBench;
    $("#view-screener").hidden   = !inScreener;
    $("#view-portfolio").hidden  = !inPortfolio;
    $("#view-dashboard").hidden  = !inDashboard;
    $("#view-analyse").hidden    = !inAnalyse;
    if (inScreener) {
      $("#screener-card-view") .hidden = view !== "cards";
      $("#screener-table-view").hidden = view !== "table";
    }
  },
  bucket() {
    const b = Store.state.ui.bucket;
    $("#nav-bottom-element-dropdown").value = b;
    $("#screener-card-view").dataset.bucket  = b;
    $("#screener-table-view").dataset.bucket = b;
    renderTable();
    renderCards();
  },
  menu() {
    const open = !!Store.state.ui.menuOpen;
    $("#nav-sheet").hidden = !open;
    $("#nav-scrim").hidden = !open;
    $("#menu-nav").setAttribute("aria-expanded", open);
  },
  bulkbar() {
    const n = Store.state.ui.selected.length;
    const bar = $("#bulkbar");
    bar.classList.toggle("is-active", n > 0);
    $("#bulk-count").textContent = n;
    /* dim the bucket button matching the currently viewed bucket — moving to same bucket is no-op */
    const cur = Store.state.ui.bucket;
    $$(".bulkbar__btn[data-bucket]").forEach(b => {
      const same = b.dataset.bucket === cur;
      b.disabled = same;
      b.title = same ? `Bereits im Bucket "${cur}"` : `In ${b.dataset.bucket} verschieben`;
    });
    /* refresh-btn tooltips reflect what will actually happen */
    const rb  = $("#bulk-refresh");
    const rbf = $("#bulk-refresh-full");
    if (rb)  { rb.title  = `Quick: ${n} ausgewählte — nur Kurs`;             rb.disabled  = n === 0; }
    if (rbf) { rbf.title = `Full: ${n} ausgewählte — Kurs + Historie (MA/RSI)`; rbf.disabled = n === 0; }
  },
  filterBar() {
    const host = $("#filter-bar");
    if (!host) return;
    const { filterAsset, filterTag } = Store.state.ui;
    const assetTypes = _allAssetTypes();
    const tags = _allTags();

    // "Alle wählen" checkbox state
    const rows = visibleRows();
    const visIds = rows.map(r => r.id);
    const selSet = new Set(Store.state.ui.selected);
    const selCount = visIds.filter(id => selSet.has(id)).length;
    const allSel = selCount === visIds.length && visIds.length > 0;
    const someSel = selCount > 0 && !allSel;

    const assetPills = assetTypes.map(a => {
      const active = filterAsset === a ? " is-active" : "";
      return `<button class="fpill${active}" data-filter-asset="${escapeHtml(a)}">${escapeHtml(a)}</button>`;
    }).join("");

    const tagPills = tags.map(tag => {
      const active = filterTag === tag ? " is-active" : "";
      return `<button class="fpill fpill--tag${active}" data-filter-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
    }).join("");

    const clearBtn = (filterAsset || filterTag)
      ? `<button class="fpill fpill--clear" id="filter-clear" title="Filter zurücksetzen">&times;</button>` : "";

    host.innerHTML = `
      <label class="fbar-selall" title="Alle wählen / Auswahl aufheben">
        <input type="checkbox" id="fbar-select-all" ${allSel ? "checked" : ""} />
      </label>
      <span class="fpill-sep"></span>
      ${assetPills}${tagPills ? `<span class="fpill-sep"></span>${tagPills}` : ""}${clearBtn}`;

    // "Alle wählen" checkbox: select all visible OR clear pill filter and deselect all
    const selAllCb = host.querySelector("#fbar-select-all");
    if (selAllCb) {
      selAllCb.indeterminate = someSel;
      selAllCb.addEventListener("click", e => {
        e.stopPropagation();
        if (filterAsset || filterTag) {
          // clear pills and deselect all
          Store.patchUi({ filterAsset: "", filterTag: "", selected: [] });
          Render.filterBar(); Render.bucket();
          return;
        }
        const shouldSel = selCount === 0;
        let sel = Store.state.ui.selected.filter(id => !visIds.includes(id));
        if (shouldSel) sel = [...sel, ...visIds];
        Store.patchUi({ selected: sel });
        Render.filterBar(); Render.bucket(); Render.bulkbar();
      });
    }

    // pill click → filter + select matching tickers + open bulkbar
    host.querySelectorAll("[data-filter-asset]").forEach(btn => {
      btn.addEventListener("click", () => {
        const next = filterAsset === btn.dataset.filterAsset ? "" : btn.dataset.filterAsset;
        const matchIds = next
          ? Store.state.tickers.filter(t => t.user.bucket === Store.state.ui.bucket && (t.stamm.asset_type || "").toLowerCase() === next.toLowerCase()).map(t => t.id)
          : [];
        Store.patchUi({ filterAsset: next, filterTag: "", selected: matchIds });
        Render.filterBar(); Render.bucket(); Render.bulkbar();
      });
    });
    host.querySelectorAll("[data-filter-tag]").forEach(btn => {
      btn.addEventListener("click", () => {
        const next = filterTag === btn.dataset.filterTag ? "" : btn.dataset.filterTag;
        const matchIds = next
          ? Store.state.tickers.filter(t => t.user.bucket === Store.state.ui.bucket && (t.user.tags || []).includes(next)).map(t => t.id)
          : [];
        Store.patchUi({ filterTag: next, filterAsset: "", selected: matchIds });
        Render.filterBar(); Render.bucket(); Render.bulkbar();
      });
    });
    const clr = host.querySelector("#filter-clear");
    if (clr) clr.addEventListener("click", () => {
      Store.patchUi({ filterAsset: "", filterTag: "", selected: [] });
      Render.filterBar(); Render.bucket(); Render.bulkbar();
    });
  }
};

/* ────────── formatting helpers ────────── */
const pctFmt = (v, plus = true) => (v == null || isNaN(v)) ? "—"
  : (plus && v > 0 ? "+" : "") + Number(v).toFixed(2) + "%";
const numFmt = (v, d = 2) => (v == null || isNaN(v)) ? "—"
  : Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const signCls = v => v == null ? "" : (v > 0 ? "pos" : v < 0 ? "neg" : "dim");

/* ────────── visible rows: bucket + triggered + asset/tag filter ────────── */
function visibleRows() {
  const { bucket, triggeredOnly, filterAsset, filterTag } = Store.state.ui;
  return Store.state.tickers
    .filter(t => t.user.bucket === bucket)
    .filter(t => !triggeredOnly || (t.calculations && t.calculations.trends && t.calculations.trends.alert_triggered))
    .filter(t => !filterAsset || (t.stamm.asset_type || "").toLowerCase() === filterAsset.toLowerCase())
    .filter(t => !filterTag || (t.user.tags || []).includes(filterTag))
    .map(flat);
}

function sortRows(rows) {
  const { sortKey, sortDir } = Store.state.ui;
  const getVal = t => t[sortKey];
  return [...rows].sort((a, b) => {
    const va = getVal(a), vb = getVal(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string" || typeof vb === "string")
      return sortDir === "asc" ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    return sortDir === "asc" ? va - vb : vb - va;
  });
}

/* ─── Status-Chip mit Lucide-Icon ───────────────────────────────────── */
function statusIcon(key, label, dim = false) {
  const icon = STATUS_LUCIDE[key];
  if (!icon) return "";
  const cls = dim
    ? "status-chip status-chip--dim"
    : `status-chip status-chip--${key}`;
  return `<span class="${cls}" title="${label}"><i data-lucide="${icon}" class="icon icon-sm"></i></span>`;
}

/* Potenzial-Status: höchste Priorität unter allen gesetzten Alerts (ungefeuert) */
function _potentialStatus(alerts) {
  if (!alerts?.length) return null;
  if (alerts.some(a => (a.type === "price_below" || a.type === "perf_below") && alertDir(a) === "sell")) return "stop_loss";
  if (alerts.some(a => a.type === "perf_above" && alertDir(a) === "sell")) return "kursziel";
  if (alerts.some(a => MOMENTUM_NEG.has(a.type))) return "momentum_neg";
  if (alerts.some(a => alertDir(a) === "sell")) return "verkauf";
  if (alerts.some(a => MOMENTUM_POS.has(a.type))) return "momentum_pos";
  if (alerts.some(a => alertDir(a) === "buy")) return "kauf";
  return "watch";
}

/* ────────── table columns ────────── */
const COLS_SELECT = [
  { key:"__select", label:`<input type="checkbox" id="tbl-select-all" aria-label="Alle wählen" />`,
    cls:"col-select", noSort:true,
    cell: t => `<input type="checkbox" class="row-select" data-id="${t.id}" aria-label="Wähle ${t.symbol}" />` }
];
const COLS_BASE = [
  { key:"status_key", label:"Status", cls:"col-status", noSort:true,
    cell: t => {
      if (t.status_key !== "halten")
        return statusIcon(t.status_key, t.status_label);
      const pot = t.alerts?.length ? _potentialStatus(t.alerts) : null;
      if (pot && pot !== "watch")
        return statusIcon(pot, `Setup: ${STATUS_MAP[pot]?.label || pot}`, true);
      if (pot === "watch")
        return `<span class="status-chip status-chip--dim" title="Watch"><i data-lucide="bookmark" class="icon icon-sm"></i></span>`;
      return "";
    }},
  { key:"symbol", label:"Symbol", cls:"col-sym",
    cell: t => `<span class="sym-strong">${t.symbol}</span><span class="sym-sub">${t.exchange||""}</span>` },
  { key:"price",             label:"Preis",   cell: t => numFmt(t.price) },
  { key:"currency_returned", label:"Währ.",   cell: t => `<span class="dim">${t.currency_returned || "—"}</span>` },
  { key:"day_change_pct",    label:"Day %",   cell: t => `<span class="${signCls(t.day_change_pct)}">${pctFmt(t.day_change_pct)}</span>` }
];
const COLS_PORTFOLIO_EXTRA = [
  { key:"performance_pct", label:"Perf %",   cell: t => `<span class="${signCls(t.performance_pct)}">${pctFmt(t.performance_pct)}</span>` },
  { key:"position_value",  label:"Wert",     cell: t => numFmt(t.position_value) },
  { key:"position_pl_abs", label:"P/L",      cell: t => `<span class="${signCls(t.position_pl_abs)}">${numFmt(t.position_pl_abs)}</span>` }
];
const COLS_TAIL = [
  { key:"month_change_pct", label:"1M %",
    cell: t => `<span class="${signCls(t.month_change_pct)}">${pctFmt(t.month_change_pct)}</span>` },
  { key:"ma20_delta_pct",  label:"MA20 Δ",  cell: t => `<span class="${signCls(t.ma20_delta_pct)}">${pctFmt(t.ma20_delta_pct)}</span>` },
  { key:"ma20",            label:"MA20",    cell: t => `<span class="dim">${numFmt(t.ma20, 2)}</span>` },
  { key:"ma50_delta_pct",  label:"MA50 Δ",  cell: t => `<span class="${signCls(t.ma50_delta_pct)}">${pctFmt(t.ma50_delta_pct)}</span>` },
  { key:"ma50",            label:"MA50",    cell: t => `<span class="dim">${numFmt(t.ma50, 2)}</span>` },
  { key:"ma200_delta_pct", label:"MA200 Δ", cell: t => `<span class="${signCls(t.ma200_delta_pct)}">${pctFmt(t.ma200_delta_pct)}</span>` },
  { key:"ma200",           label:"MA200",   cell: t => `<span class="dim">${numFmt(t.ma200, 2)}</span>` },
  { key:"rsi",             label:"RSI",      cell: t => numFmt(t.rsi, 1) },
  { key:"macd_histogram",  label:"MACD H",   cell: t => `<span class="${signCls(t.macd_histogram)}">${numFmt(t.macd_histogram, 2)}</span>` },
  { key:"sentiment_score", label:"Sent.",    cell: t => `<span class="${signCls(t.sentiment_score)}">${numFmt(t.sentiment_score, 2)}</span>` },
  { key:"trend_strength",  label:"Trend",
    cell: t => {
      const cls = t.trend_strength === "stark" ? "pill--strong" : t.trend_strength === "schwach" ? "pill--weak" : "";
      return `<span class="pill ${cls}">${t.trend_strength || "—"}</span>`;
    } },
  { key:"vol_ratio",       label:"Vol.",
    sortValue: t => (t.volume && t.avg_volume) ? t.volume / t.avg_volume : null,
    cell: t => numFmt((t.volume && t.avg_volume) ? t.volume / t.avg_volume : null, 2) },
  { key:"high_52w",         label:"52W H",   cell: t => `<span class="dim">${numFmt(t.high_52w, 2)}</span>` },
  { key:"low_52w",          label:"52W T",   cell: t => `<span class="dim">${numFmt(t.low_52w,  2)}</span>` },
  { key:"asset_type",      label:"Typ",     cell: t => `<span class="pill">${t.asset_type || "—"}</span>` },
  { key:"sector",          label:"Sektor",  cell: t => t.sector || "—" }
];

function columnsForBucket(bucket) {
  if (bucket === "portfolio") return [...COLS_SELECT, ...COLS_BASE, ...COLS_PORTFOLIO_EXTRA, ...COLS_TAIL];
  return [...COLS_SELECT, ...COLS_BASE, ...COLS_TAIL];
}

function renderTable() {
  const head = $("#tbl-screener-head");
  const body = $("#tbl-screener-body");
  if (!head || !body) return;
  const { bucket, sortKey, sortDir } = Store.state.ui;
  const cols = columnsForBucket(bucket);

  head.innerHTML = cols.map(c => {
    const active = c.key === sortKey;
    const sortAttr = active ? (sortDir === "asc" ? "ascending" : "descending") : "none";
    const ind = c.noSort ? "" : (active ? (sortDir === "asc" ? "▲" : "▼") : "•");
    const sortable = c.noSort ? "" : ' data-sortable="1"';
    return `<th class="${c.cls||""}" data-col="${c.key}" aria-sort="${sortAttr}"${sortable} scope="col">${c.label}<span class="sort-ind">${ind}</span></th>`;
  }).join("");

  const rows = visibleRows();
  const sortCol = cols.find(c => c.key === sortKey);
  const getVal = t => sortCol && sortCol.sortValue ? sortCol.sortValue(t) : t[sortKey];
  rows.sort((a, b) => {
    const va = getVal(a), vb = getVal(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string" || typeof vb === "string")
      return sortDir === "asc" ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    return sortDir === "asc" ? va - vb : vb - va;
  });

  body.innerHTML = rows.map(t => {
    const trigCls = t.alert_triggered ? "is-trig" : "";
    return `<tr class="${trigCls}" data-id="${t.id}">${cols.map(c => `<td class="${c.cls||""}">${c.cell(t)}</td>`).join("")}</tr>`;
  }).join("")
    || `<tr><td colspan="${cols.length}" class="dim" style="text-align:center;padding:24px">Keine Einträge im Bucket "${bucket}"</td></tr>`;

  if (window.lucide) lucide.createIcons();

  // sort
  head.querySelectorAll("th[data-sortable]").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.col;
      const ui = Store.state.ui;
      const dir = (ui.sortKey === k && ui.sortDir === "desc") ? "asc" : "desc";
      Store.patchUi({ sortKey: k, sortDir: dir });
      renderTable(); renderCards();
    });
  });

  // bulk select
  const selectAll = $("#tbl-select-all");
  if (selectAll) {
    selectAll.checked = false; selectAll.indeterminate = false;
    const allIds = rows.map(r => r.id);
    const selSet = new Set(Store.state.ui.selected);
    const intersect = allIds.filter(id => selSet.has(id));
    if (intersect.length === allIds.length && allIds.length) selectAll.checked = true;
    else if (intersect.length > 0) selectAll.indeterminate = true;

    selectAll.addEventListener("click", (e) => {
      e.stopPropagation();
      const checked = selectAll.checked;
      const visIds = rows.map(r => r.id);
      let sel = Store.state.ui.selected.filter(id => !visIds.includes(id));
      if (checked) sel = [...sel, ...visIds];
      Store.patchUi({ selected: sel });
      Render.bulkbar();
      renderTable();
    });
  }
  body.querySelectorAll(".row-select").forEach(cb => {
    const id = cb.dataset.id;
    cb.checked = Store.state.ui.selected.includes(id);
    cb.addEventListener("click", e => e.stopPropagation());
    cb.addEventListener("change", () => {
      const sel = new Set(Store.state.ui.selected);
      if (cb.checked) sel.add(id); else sel.delete(id);
      Store.patchUi({ selected: [...sel] });
      Render.bulkbar();
    });
  });

  // row click → info
  body.querySelectorAll("tr[data-id]").forEach(tr => {
    tr.addEventListener("click", e => {
      if (e.target.closest(".row-select")) return;
      openInfo(tr.dataset.id);
    });
  });
}

/* ────────── card templates ────────── */
function rsiClass(v) { if (v == null) return { cls:"", label:"—" }; if (v >= 70) return { cls:"hot", label:"hot" }; if (v <= 30) return { cls:"cold", label:"cold" }; return { cls:"ok", label:"OK" }; }
function trendBar(v) { if (v == null) v = 0; const n = Math.max(0, Math.min(10, Math.round(Math.abs(v) * 10))); const neg = v < 0 ? "neg" : ""; let segs = ""; for (let i = 0; i < 10; i++) segs += `<span class="trend__seg ${i < n ? "is-on " + neg : ""}"></span>`; return `<span class="trend__bar">${segs}</span>`; }

function alertChips(t, inline) {
  const alerts = t.smart_alerts && t.smart_alerts.length ? t.smart_alerts : t.alerts.map(a => ({...a, _trig:false}));
  if (!alerts.length) return "";
  const lblMap = { price_below:"≤", price_above:"≥", rsi_above:"RSI>", rsi_below:"RSI<", ma20_below:"<MA20", ma50_below:"<MA50", ma200_below:"<MA200", macd_bullish:"MACD↑", macd_bearish:"MACD↓", reversal_up_short:"↑MACD", reversal_down_short:"↓MACD", reversal_up_long:"↑MA200", reversal_down_long:"↓MA200", vol_spike:"VOL×", perf_below:"Perf ≤", perf_above:"Perf ≥" };
  // EUR-konvertierte Quotes für korrekte Distanzberechnung
  const q = t._raw ? {
    ...t._raw.quotes,
    price:     t.price,
    ma20:      t.ma20,
    ma50:      t.ma50,
    ma200:     t.ma200,
    _perf_pct: t.performance_pct,
  } : null;
  const out = alerts.map(a => {
    let lbl, v;
    if (a.type === "ma_below_pct" || a.type === "ma_above_pct") {
      const sign = a.type === "ma_above_pct" ? "+" : "−";
      lbl = `${a.type==="ma_above_pct"?">":"<"}${(a.ma||"ma50").toUpperCase()} ${sign}${a.threshold}%`;
      v = "";
    } else if (a.type === "perf_below" || a.type === "perf_above") {
      lbl = lblMap[a.type];
      v   = a.type === "perf_below" ? `−${a.threshold}%` : `+${a.threshold}%`;
    } else {
      lbl = lblMap[a.type] || a.type;
      v   = a.type === "rsi_above" || a.type === "rsi_below" ? a.threshold
          : a.type === "vol_spike" ? `${a.threshold}×`
          : numFmt(a.threshold);
    }
    const dir = alertDir(a);
    const dirBadge = dir === "watch" ? "" : ` <span class="alerts__dir alerts__dir--${dir}">${dir === "buy" ? "B" : "S"}${a.nk_shares != null ? " " + numFmt(a.nk_shares, 0) : ""}</span>`;
    const dist = q && !a._trig ? alertDistance(a, q) : { pct: null, near: false };
    const distLbl = dist.pct != null ? ` <span class="alerts__dist ${dist.near ? "is-near" : ""}">${dist.pct >= 0 ? "+" : ""}${dist.pct.toFixed(1)}%</span>` : "";
    const grpBadge = a.group ? ` <span class="alerts__grp" title="AND-Gruppe">&</span>` : "";
    return `<span class="alerts__chip alerts__chip--${dir} ${a._trig ? "is-trig" : ""}"><b>${lbl}</b>${v}${dirBadge}${distLbl}${grpBadge}</span>`;
  });
  return inline
    ? `<span class="alerts" style="display:inline-flex"><span class="tcard__label">Alerts</span>${out.join("")}</span>`
    : `<div class="alerts"><span class="tcard__label">Alerts</span>${out.join("")}</div>`;
}

function actionsRow(t) {
  const isPort = t.bucket === "portfolio";
  const tvLink = t.tradingview_url
    ? `<a class="tcard__act tcard__ext-link" href="${t.tradingview_url}" target="_blank" rel="noopener" title="TradingView">
        <img src="https://s3.tradingview.com/userpics/6171439-mFQX_big.png" class="tcard__ext-icon" alt="TV" />
       </a>` : "";
  const stLink = t.stocktwits_url
    ? `<a class="tcard__act tcard__ext-link" href="${t.stocktwits_url}" target="_blank" rel="noopener" title="StockTwits">
        <img src="https://avatars.githubusercontent.com/u/30304?s=200&v=4" class="tcard__ext-icon" alt="ST" />
       </a>` : "";
  return `<div class="tcard__actions">
    <button class="tcard__act btn-info" data-id="${t.id}" aria-label="Details" title="Details"><i data-lucide="info" class="icon icon-sm"></i><span class="tcard__act-lbl">Info</span></button>
    <button class="tcard__act btn-edit" data-id="${t.id}" aria-label="Bearbeiten" title="Bearbeiten"><i data-lucide="pencil" class="icon icon-sm"></i><span class="tcard__act-lbl">Edit</span></button>
    ${isPort ? `<button class="tcard__act btn-nk" data-id="${t.id}" aria-label="Nachkauf" title="Nachkauf-Kalkulator"><i data-lucide="calculator" class="icon icon-sm"></i><span class="tcard__act-lbl">Calc</span></button>` : ""}
    <span class="tcard__ext-links">${tvLink}${stLink}</span>
  </div>`;
}

function priceLine(t) {
  const sym = ccySym(t.currency_returned || t.currency || "USD");
  return `<span class="tcard__chip">${numFmt(t.price)} <span class="dim">${sym}</span> <span class="${signCls(t.day_change_pct)}">(${pctFmt(t.day_change_pct)})</span></span>`;
}
function ccySym(code) { return code === "USD" ? "$" : code === "EUR" ? "€" : code === "GBP" ? "£" : code || ""; }
function signedNum(v, decimals = 0, unit = "") { return v == null ? "—" : `${v >= 0 ? "+" : ""}${numFmt(v, decimals)}${unit}`; }
function trendChip(t) {
  return `<span class="trend trend--stacked">
    <span class="tcard__label">Trend<span class="trend__score ${signCls(t.sentiment_score)}">${numFmt(t.sentiment_score, 2)}</span></span>
    ${trendBar(t.sentiment_score)}
  </span>`;
}
function rsiChip(t) { const r = rsiClass(t.rsi); return `<span><span class="tcard__label">RSI</span><span class="rsi__dot ${r.cls}"></span>${numFmt(t.rsi, 0)} <span class="dim">(${r.label})</span></span>`; }

function selectChip(t) {
  const checked = Store.state.ui.selected.includes(t.id);
  return `<input type="checkbox" class="tcard__select card-select" data-id="${t.id}" aria-label="Wähle ${t.symbol}" ${checked ? "checked" : ""} />`;
}

function volChip(t) {
  if (t.volume == null || t.avg_volume == null || t.avg_volume === 0) return "";
  const ratio = t.volume / t.avg_volume;
  const cls = ratio >= 2 ? "pos" : "dim";
  const arrow = ratio >= 2 ? "↑ " : "";
  return `<span><span class="tcard__label">Vol</span><span class="${cls}">${arrow}${numFmt(ratio, 1)}×</span></span>`;
}

function sparkSVG(t) {
  const closes = t.last7d;
  if (!closes || closes.length < 2) {
    return `<div class="tcard__spark-empty"></div>`;
  }
  const W = 200, H = 56;
  const isPort = t.bucket === "portfolio";
  // 52W H/L excluded from scale — they can be far from current price and would compress the chart
  const scaleExtras = [t.ma20, t.ma50, t.ma200,
                       isPort ? t.entry_price_manual : null].filter(v => v != null);
  const all    = [...closes, ...scaleExtras];
  const rawMin = Math.min(...all), rawMax = Math.max(...all);
  const pad    = (rawMax - rawMin) * 0.1 || rawMin * 0.02 || 1;
  const minV   = rawMin - pad, maxV = rawMax + pad;
  const rng    = maxV - minV;
  const toX    = i => (i / (closes.length - 1)) * W;
  const toY    = v => H - ((v - minV) / rng) * H;
  const pts    = closes.map((c, i) => `${toX(i).toFixed(1)},${toY(c).toFixed(1)}`).join(" ");
  const lx     = toX(closes.length - 1).toFixed(1);
  const ly     = toY(closes[closes.length - 1]).toFixed(1);
  const isPos  = closes[closes.length - 1] >= closes[0];
  const col    = isPos ? "var(--pos)" : "var(--neg)";
  const area   = `M0,${toY(closes[0]).toFixed(1)} `
    + closes.slice(1).map((c, i) => `L${toX(i + 1).toFixed(1)},${toY(c).toFixed(1)}`).join(" ")
    + ` L${W},${H} L0,${H} Z`;
  const hline = (val, dash, stroke, width, op) => {
    if (val == null) return "";
    const y = Math.max(0.5, Math.min(H - 0.5, toY(val))).toFixed(1);
    return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${stroke}" stroke-width="${width}" stroke-dasharray="${dash}" opacity="${op}"/>`;
  };
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none" style="display:block">
    <defs><linearGradient id="sg${t.id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${col}" stop-opacity=".14"/>
      <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#sg${t.id})"/>
    ${hline(t.high_52w, "3 3", "#888", 1, ".45")}
    ${hline(t.low_52w,  "3 3", "#888", 1, ".45")}
    ${hline(t.ma200, "", "#1B4E8C", 1, ".70")}
    ${hline(t.ma50,  "", "#3A82C4", 1, ".65")}
    ${hline(t.ma20,  "", "#6EC6E6", 1, ".80")}
    ${isPort ? hline(t.entry_price_manual, "", "#9B6DFF", 2, ".90") : ""}
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="3" fill="${col}" stroke="var(--bg)" stroke-width="1.5"/>
  </svg>`;
}

function maValueCol(t) {
  const row = (lbl, val, color, bold) => {
    if (val == null) return "";
    const style = [color ? `color:${color}` : "", bold ? "font-weight:700" : ""].filter(Boolean).join(";");
    return `<div class="tcard__maval-row"${style ? ` style="${style}"` : ""}>
      <span class="tcard__maval-lbl">${lbl}</span>
      <span class="tcard__maval-num">${numFmt(val, 2)}</span>
    </div>`;
  };
  return `<div class="tcard__ma-vals">
    ${row("MA20",  t.ma20,  "#6EC6E6")}
    ${row("MA50",  t.ma50,  "#3A82C4")}
    ${row("MA200", t.ma200, "#1B4E8C")}
    ${row("52H",   t.high_52w,  null)}
    ${row("52T",   t.low_52w,   null)}
  </div>`;
}

function _tagPills(t) {
  if (!t.tags || !t.tags.length) return "";
  return `<div class="tcard__tags">${t.tags.map(tag => `<span class="tag-pill tag-pill--sm">${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function _cardBody(t) {
  return `<div class="tcard__body">
    <div class="tcard__chart">
      <div class="tcard__chart-row">
        <div class="tcard__spark">${sparkSVG(t)}</div>
        ${maValueCol(t)}
      </div>
    </div>
    <div class="tcard__metrics">
      ${[rsiChip(t), volChip(t), trendChip(t)].filter(Boolean).map(h => `<div>${h}</div>`).join("")}
    </div>
    ${_tagPills(t)}
  </div>`;
}

function cardDefault(t) {
  return `<article class="tcard has-select ${t.alert_triggered ? "is-trig is-trig--" + (t.alert_triggered_dir || "sell") : ""}" data-id="${t.id}">
    ${selectChip(t)}
    <div class="tcard__hd">
      <span class="tcard__sym">${t.symbol}</span>
      ${t.name ? `<span class="tcard__name">${t.name}</span>` : ""}
      <div class="tcard__hd-right">
        ${t.status_key !== "halten" ? statusIcon(t.status_key, t.status_label) : ""}
        ${priceLine(t)}
      </div>
    </div>
    ${_cardBody(t)}
    ${actionsRow(t)}
  </article>`;
}

function cardPortfolio(t) {
  const shares   = t.entry_shares != null ? `<span class="pill pill--sm">${numFmt(t.entry_shares, 0)}&thinsp;St.</span>` : "";
  const invested = (t.entry_price_manual != null && t.entry_shares != null)
    ? t.entry_price_manual * t.entry_shares : null;

  // sub-row left: invested € | abs delta €
  const subLeft = invested != null ? `
    <span class="tcard__sub-inv"><span class="tcard__sub-lbl">€</span>${numFmt(invested, 0)}</span>
    ${t.position_pl_abs != null ? `<span class="tcard__hd-sep">|</span><span class="${signCls(t.position_pl_abs)} tcard__sub-delta">${t.position_pl_abs >= 0 ? "+" : ""}${numFmt(t.position_pl_abs, 0)}€</span>` : ""}
  ` : "";

  // sub-row right: EP (purple) + P/L%
  const subRight = t.entry_price_manual != null ? `
    <span class="tcard__sub-ep">
      <span class="tcard__sub-lbl tcard__ep-lbl">EP</span>
      <span class="tcard__ep-val">${numFmt(t.entry_price_manual)}€</span>
      <span class="${signCls(t.performance_pct)}">${pctFmt(t.performance_pct)}</span>
    </span>
  ` : "";

  return `<article class="tcard has-select ${t.alert_triggered ? "is-trig is-trig--" + (t.alert_triggered_dir || "sell") : ""}" data-id="${t.id}">
    ${selectChip(t)}
    <div class="tcard__hd">
      <span class="tcard__sym">${t.symbol}</span>
      ${t.name ? `<span class="tcard__name">${t.name}</span>` : ""}
      ${shares}
      <div class="tcard__hd-right">
        ${t.status_key !== "halten" ? statusIcon(t.status_key, t.status_label) : ""}
        ${priceLine(t)}
      </div>
    </div>
    ${subLeft || subRight ? `<div class="tcard__price-sub">
      <span class="tcard__sub-left">${subLeft}</span>
      <span class="tcard__sub-right">${subRight}</span>
    </div>` : ""}
    ${_cardBody(t)}
    ${actionsRow(t)}
  </article>`;
}

function renderCards() {
  const host = $("#screener-card-view");
  if (!host) return;
  const { bucket } = Store.state.ui;
  const rows = sortRows(visibleRows());
  if (!rows.length) {
    const total = Store.state.tickers.length;
    const msg = total === 0
      ? `0 Einträge — starte mit einem JSON-Import`
      : `Keine Einträge im Bucket "${bucket}"`;
    host.innerHTML = `<div class="tcard__empty">
      <div style="margin-bottom:12px">${msg}</div>
      <button class="modal__btn modal__btn--primary empty-cta">
        <i data-lucide="upload" class="icon icon-sm" style="vertical-align:-3px"></i> JSON importieren
      </button>
    </div>`;
    host.querySelector(".empty-cta").addEventListener("click", () => openModal("#modal-import"));
    if (window.lucide) lucide.createIcons();
    return;
  }
  const tpl = bucket === "portfolio" ? cardPortfolio : cardDefault;
  host.innerHTML = rows.map(tpl).join("");
  host.querySelectorAll(".btn-info").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); openInfo(e.currentTarget.dataset.id); }));
  host.querySelectorAll(".btn-edit").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); openEdit(e.currentTarget.dataset.id); }));
  host.querySelectorAll(".btn-nk")  .forEach(b => b.addEventListener("click", e => { e.stopPropagation(); openNachkauf(e.currentTarget.dataset.id); }));
  host.querySelectorAll(".card-select").forEach(cb => {
    cb.addEventListener("click", e => e.stopPropagation());
    cb.addEventListener("change", e => {
      const id = e.target.dataset.id;
      const sel = new Set(Store.state.ui.selected);
      if (e.target.checked) sel.add(id); else sel.delete(id);
      Store.patchUi({ selected: [...sel] });
      Render.bulkbar();
    });
  });

  if (window.lucide) lucide.createIcons();
}

/* ════════════════════════════════════════════════════
   SECTION 6 — EVENTS / MODALS / FEATURES
   ════════════════════════════════════════════════════ */

/* ─── toast ─── */
let toastTimer = null;
function toast(msg, kind = "") {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.className = "toast" + (kind ? ` toast--${kind}` : "");
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2400);
}

/* ─── benchmark bar ─── */
function renderBenchBar() {
  const el = $("#benchbar"); if (!el) return;
  const benchmarks = Store.state.benchmarks;

  function pctSpan(v) {
    if (v == null) return `<span class="bench__na">—</span>`;
    const cls = v >= 0 ? "pos" : "neg";
    return `<span class="bench__pct bench__pct--${cls}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</span>`;
  }

  function trendSegs(closes) {
    if (!closes || closes.length < 2)
      return Array.from({ length: 5 }, () => `<span class="bench__seg bench__seg--flat"></span>`).join("");
    const slice = closes.slice(0, 6);
    return Array.from({ length: Math.min(5, slice.length - 1) }, (_, i) => {
      const cls = slice[i] >= slice[i + 1] ? "up" : "dn";
      return `<span class="bench__seg bench__seg--${cls}"></span>`;
    }).join("");
  }

  function itemHtml(b) {
    const price = b.price != null ? b.price.toLocaleString("de-DE", { maximumFractionDigits: 0 }) : "—";
    return `<div class="bench__item">
      <div class="bench__item-top">
        <span class="bench__label">${b.label}</span>
        <span class="bench__price">${price}</span>
        <span class="bench__segs">${trendSegs(b.closes)}</span>
      </div>
      <div class="bench__item-bot">
        <span class="bench__tf"><span class="bench__tf-lbl">1T</span>${pctSpan(b.day_change_pct)}</span>
        <span class="bench__tf"><span class="bench__tf-lbl">1W</span>${pctSpan(b.week_change_pct)}</span>
        <span class="bench__tf"><span class="bench__tf-lbl">1M</span>${pctSpan(b.month_change_pct)}</span>
      </div>
    </div>`;
  }

  el.innerHTML = `
    <div class="bench__scroll">
      ${benchmarks.map(itemHtml).join('<span class="bench__divider"></span>')}
    </div>
    <button class="bench__gear" id="btn-bench-refresh" title="Benchmarks aktualisieren" aria-label="Benchmarks aktualisieren">
      <i data-lucide="refresh-cw" class="icon icon-sm"></i>
    </button>
    <button class="bench__gear" id="btn-bench-settings" title="Benchmark-Einstellungen" aria-label="Benchmark-Einstellungen">
      <i data-lucide="settings-2" class="icon icon-sm"></i>
    </button>`;

  $("#btn-bench-refresh") ?.addEventListener("click", async e => {
    const btn = e.currentTarget;
    btn.classList.add("is-loading"); btn.disabled = true;
    await API.fetchBenchmarks();
    btn.classList.remove("is-loading"); btn.disabled = false;
  });
  $("#btn-bench-settings")?.addEventListener("click", openBenchSettings);
  if (window.lucide) lucide.createIcons();
}

function openBenchSettings() {
  const benchmarks = Store.state.benchmarks;
  $("#bench-settings-list").innerHTML = benchmarks.map((b, i) => `
    <div class="modal__row2">
      <div class="modal__field">
        <label>Label</label>
        <input class="bench-cfg-label" data-idx="${i}" type="text" value="${b.label}" placeholder="z.B. DAX" maxlength="8" />
      </div>
      <div class="modal__field">
        <label>Yahoo-Symbol</label>
        <input class="bench-cfg-sym" data-idx="${i}" type="text" value="${b.symbol || ""}" placeholder="z.B. ^GDAXI" />
      </div>
    </div>`).join("");
  openModal("#modal-bench");
}

function saveBenchSettings() {
  const benchmarks = Store.state.benchmarks;
  $$(".bench-cfg-label").forEach(el => {
    const i = +el.dataset.idx;
    const v = el.value.trim(); if (v) benchmarks[i].label = v;
  });
  $$(".bench-cfg-sym").forEach(el => {
    const i = +el.dataset.idx;
    const v = el.value.trim(); if (v) benchmarks[i].symbol = v;
  });
  Store.save();
  closeModal("#modal-bench");
  renderBenchBar();
  toast("Gespeichert", "pos");
}

/* ─── modal open/close ─── */
function openModal(sel) {
  const m = $(sel); if (!m) return;
  m.hidden = false;
  const first = m.querySelector("input, button, textarea, select");
  if (first) first.focus();
  if (window.lucide) lucide.createIcons();
}
function closeModal(sel) {
  const m = typeof sel === "string" ? $(sel) : sel;
  if (m) m.hidden = true;
}

/* ─── INFO modal ─── */
function openInfo(id) {
  const t = Store.byId(id); if (!t) return;
  _currentInfoTicker = flat(t);
  const s = t.stamm, u = t.user, c = (t.calculations && t.calculations.trends) || {};
  $("#modal-info-title").textContent = `${s.symbol} · ${s.name || ""}`;
  const news = eff(t, "recent_news");
  const cat  = eff(t, "next_catalysts");
  const cb   = eff(t, "core_business");
  const tr   = eff(t, "trend_reason");
  const why  = eff(t, "why_not");

  $("#modal-info-body").innerHTML = `
    <div class="modal__field"><label>Sektor / Typ</label><div>${s.sector || "—"} · ${s.asset_type || "—"} · ${s.market_cap_size || "—"}</div></div>
    ${cb  ? `<div class="modal__field"><label>Geschäftsmodell</label><div>${escapeHtml(cb)}</div></div>` : ""}
    ${tr  ? `<div class="modal__field"><label>Trend-Grund</label><div>${escapeHtml(tr)}</div></div>` : ""}
    ${why ? `<div class="modal__field"><label>Why-Not</label><div>${escapeHtml(why)}</div></div>` : ""}
    ${Array.isArray(news) && news.length ? `<div class="modal__field"><label>News</label><ul style="margin:0;padding-left:18px">${news.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul></div>` : ""}
    ${Array.isArray(cat) && cat.length ? `<div class="modal__field"><label>Katalysatoren</label><ul style="margin:0;padding-left:18px">${cat.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul></div>` : ""}
    ${u.notes ? `<div class="modal__field"><label>Notizen</label><div>${escapeHtml(u.notes)}</div></div>` : ""}
    ${s.tradingview_url ? `<div class="modal__field"><label>Chart</label><a href="${s.tradingview_url}" target="_blank" rel="noopener">TradingView ↗</a></div>` : ""}
    <div class="modal__field"><label>Sentiment / Trend</label><div>${c.sentiment || "—"} · ${numFmt(c.sentiment_score, 2)} · ${c.trend_strength || "—"}</div></div>
    <div class="modal__field"><label>Quote-Zeitpunkt</label><div>${t.quotes.ts ? new Date(t.quotes.ts).toLocaleString("de-DE") : "—"} · Quelle: ${t.quotes._source || "—"}</div></div>
  `;
  if (typeof window.PROMPTS !== "undefined") updatePromptText();
  openModal("#modal-info");
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

/* ─── EDIT modal ─── */
function openEdit(id) {
  const t = Store.byId(id); if (!t) return;
  Store.patchUi({ editingId: id });
  $("#modal-edit-title").textContent = `${t.stamm.symbol} · Bearbeiten`;
  $("#edit-bucket").value   = t.user.bucket || "neutral";
  $("#edit-priority").value = t.user.priority || "";
  $("#edit-entry-price").value  = t.user.entry_price_manual != null ? t.user.entry_price_manual : "";
  $("#edit-entry-shares").value = t.user.entry_shares != null ? t.user.entry_shares : "";
  $("#edit-notes").value = t.user.notes || "";
  renderTagEditor(t.user.tags || []);
  $("#edit-td-symbol").value = t.stamm.twelvedata_symbol || t.stamm.symbol || "";
  $("#edit-td-mic").value    = t.stamm.twelvedata_mic_code || "";
  $("#edit-yahoo-symbol").value = t.stamm.yahoo_symbol || "";
  $("#edit-tv-url").value = t.stamm.tradingview_url || "";
  $("#edit-st-url").value = t.stamm.stocktwits_url || `https://stocktwits.com/symbol/${t.stamm.symbol}`;
  /* show guessed Yahoo-symbol as placeholder for unconfigured tickers */
  $("#edit-yahoo-symbol").placeholder = `Vorgeschlagen: ${API._guessYahooSymbol(t) || "—"}`;
  /* reset lookup UI */
  $("#edit-td-results").hidden = true;
  $("#edit-td-results").innerHTML = "";
  $("#edit-td-status").hidden = true;
  $("#edit-td-status").textContent = "";
  renderAlertEditor(t.user.alerts || [], t);
  const isPortfolio = (t.user.bucket || "neutral") === "portfolio";
  $("#edit-trades-section").hidden = !isPortfolio;
  if (isPortfolio) renderTradeEditor(t.user.trades || []);
  openModal("#modal-edit");
}
/* ALERT_NO_THRESHOLD, ALERT_DEFAULT_DIR, alertDir — imported from lib/status-logic.js */

/* A6: distance to trigger — pct>0 = not yet, pct<0 = past trigger, near = within 5% */
function alertDistance(a, q) {
  if (!a || !q) return { pct: null, near: false };
  const within = (p, lim) => Math.abs(p) <= lim;
  const calc = (current, target, lim) => {
    if (current == null || target == null || target === 0) return { pct: null, near: false };
    const pct = ((current - target) / Math.abs(target)) * 100;
    return { pct, near: within(pct, lim) };
  };
  switch (a.type) {
    case "price_below": return calc(q.price, a.threshold, 5);
    case "price_above": return calc(a.threshold, q.price, 5);
    case "rsi_below":   return q.rsi != null && a.threshold != null
      ? { pct: q.rsi - a.threshold, near: within(q.rsi - a.threshold, 5) } : { pct: null, near: false };
    case "rsi_above":   return q.rsi != null && a.threshold != null
      ? { pct: a.threshold - q.rsi, near: within(a.threshold - q.rsi, 5) } : { pct: null, near: false };
    case "ma20_below":  return calc(q.price, q.ma20,  3);
    case "ma50_below":  return calc(q.price, q.ma50,  3);
    case "ma200_below": return calc(q.price, q.ma200, 3);
    case "ma_below_pct": {
      const mv = a.ma ? q[a.ma] : null;
      if (mv == null || a.threshold == null) return { pct: null, near: false };
      return calc(q.price, mv * (1 - a.threshold / 100), 5);
    }
    case "ma_above_pct": {
      const mv = a.ma ? q[a.ma] : null;
      if (mv == null || a.threshold == null) return { pct: null, near: false };
      return calc(mv * (1 + a.threshold / 100), q.price, 5);
    }
    case "perf_below": {
      if (q._perf_pct == null || a.threshold == null) return { pct: null, near: false };
      const d = q._perf_pct + Math.abs(a.threshold); // positiv = noch X pp bis −threshold
      return { pct: d, near: within(d, 3) };
    }
    case "perf_above": {
      if (q._perf_pct == null || a.threshold == null) return { pct: null, near: false };
      const d = Math.abs(a.threshold) - q._perf_pct; // positiv = noch X pp bis +threshold
      return { pct: d, near: within(d, 3) };
    }
    default: return { pct: null, near: false };
  }
}

function renderAlertEditor(alerts, t) {
  const host = $("#edit-alerts-list");
  const MA_PCT = new Set(["ma_below_pct","ma_above_pct"]);

  host.innerHTML = alerts.map((a, i) => {
    const noTh    = ALERT_NO_THRESHOLD.has(a.type);
    const needsMa = MA_PCT.has(a.type);
    const isVol   = a.type === "vol_spike";
    const isPerf  = a.type === "perf_below" || a.type === "perf_above";
    const pholder = needsMa ? "% Abstand" : isVol ? "Faktor (z.B. 2)" : isPerf ? "% (z.B. 10)" : "Schwelle";
    const defVal  = a.threshold ?? (needsMa ? 20 : isVol ? 2 : isPerf ? 10 : "");
    const maVal   = a.ma || "ma50";
    const dir     = alertDir(a);
    const prevGrp = i > 0 ? alerts[i - 1].group : null;
    const linked  = i > 0 && a.group && prevGrp === a.group;
    return `<div class="alert-row" data-idx="${i}" data-group="${a.group || ""}">
      <div class="alert-row__main">
        <select class="al-type">
          <option value="price_below"         ${a.type==="price_below"        ?"selected":""}>Preis ≤</option>
          <option value="price_above"         ${a.type==="price_above"        ?"selected":""}>Preis ≥</option>
          <option value="ma_below_pct"        ${a.type==="ma_below_pct"       ?"selected":""}>Preis ≤ MA −X%</option>
          <option value="ma_above_pct"        ${a.type==="ma_above_pct"       ?"selected":""}>Preis ≥ MA +X%</option>
          <option value="rsi_above"           ${a.type==="rsi_above"          ?"selected":""}>RSI ≥</option>
          <option value="rsi_below"           ${a.type==="rsi_below"          ?"selected":""}>RSI ≤</option>
          <option value="macd_bullish"        ${a.type==="macd_bullish"       ?"selected":""}>MACD bullisch</option>
          <option value="macd_bearish"        ${a.type==="macd_bearish"       ?"selected":""}>MACD bärisch</option>
          <option value="reversal_up_short"   ${a.type==="reversal_up_short"  ?"selected":""}>Trendwende ↑ kurzfristig (MACD)</option>
          <option value="reversal_down_short" ${a.type==="reversal_down_short"?"selected":""}>Trendwende ↓ kurzfristig (MACD)</option>
          <option value="reversal_up_long"    ${a.type==="reversal_up_long"   ?"selected":""}>Trendwende ↑ langfristig (MA200)</option>
          <option value="reversal_down_long"  ${a.type==="reversal_down_long" ?"selected":""}>Trendwende ↓ langfristig (MA200)</option>
          <option value="vol_spike"           ${a.type==="vol_spike"          ?"selected":""}>Volumen Spike ≥ N×Ø</option>
          <option value="perf_below"          ${a.type==="perf_below"         ?"selected":""}>Perf. ≤ −X%</option>
          <option value="perf_above"          ${a.type==="perf_above"         ?"selected":""}>Perf. ≥ +X% 💰</option>
        </select>
        <select class="al-ma" ${needsMa ? "" : "hidden"}>
          <option value="ma20"  ${maVal==="ma20" ?"selected":""}>MA20</option>
          <option value="ma50"  ${maVal==="ma50" ?"selected":""}>MA50</option>
          <option value="ma200" ${maVal==="ma200"?"selected":""}>MA200</option>
        </select>
        <input class="al-th" type="number" step="any" value="${defVal}" placeholder="${pholder}" ${noTh?"hidden":""} />
        <select class="al-dir" title="Richtung Buy/Sell/Watch">
          <option value="buy"   ${dir==="buy"  ?"selected":""}>Buy</option>
          <option value="sell"  ${dir==="sell" ?"selected":""}>Sell</option>
          <option value="watch" ${dir==="watch"?"selected":""}>Watch</option>
        </select>
        ${i > 0 ? `<label class="al-link" title="Mit vorherigem Alert per AND verknüpfen">
          <input type="checkbox" class="al-and" ${linked ? "checked" : ""}/>&amp;
        </label>` : `<span class="al-link al-link--placeholder"></span>`}
        <button class="al-del" aria-label="Alert löschen"><i data-lucide="x" class="icon icon-sm"></i></button>
      </div>
    </div>`;
  }).join("");

  host.querySelectorAll(".al-del").forEach(b => b.addEventListener("click", e => e.currentTarget.closest(".alert-row").remove()));
  host.querySelectorAll(".al-type").forEach(sel => {
    sel.addEventListener("change", () => {
      const row     = sel.closest(".alert-row");
      const noTh    = ALERT_NO_THRESHOLD.has(sel.value);
      const needsMa = MA_PCT.has(sel.value);
      const isVol   = sel.value === "vol_spike";
      const isPerf  = sel.value === "perf_below" || sel.value === "perf_above";
      const thEl = row.querySelector(".al-th");
      thEl.hidden      = noTh;
      thEl.placeholder = needsMa ? "% Abstand" : isVol ? "Faktor (z.B. 2)" : isPerf ? "% (z.B. 10)" : "Schwelle";
      if (needsMa && !thEl.value) thEl.value = 20;
      if (isVol   && !thEl.value) thEl.value = 2;
      if (isPerf  && !thEl.value) thEl.value = 10;
      row.querySelector(".al-ma").hidden = !needsMa;
      /* auto-update direction default when type changes */
      const dirSel = row.querySelector(".al-dir");
      if (dirSel) dirSel.value = ALERT_DEFAULT_DIR[sel.value] || "watch";
    });
  });
  if (window.lucide) lucide.createIcons();
}

function collectAlertsFromEditor() {
  const rows = $$("#edit-alerts-list .alert-row");
  const out = [];
  let currentGroup = null;
  rows.forEach((row, i) => {
    const type   = row.querySelector(".al-type").value;
    const maEl   = row.querySelector(".al-ma");
    const ma     = (maEl && !maEl.hidden) ? maEl.value : undefined;
    const dir    = row.querySelector(".al-dir")?.value || ALERT_DEFAULT_DIR[type] || "watch";
    const linked = i > 0 && row.querySelector(".al-and")?.checked;
    let group;
    if (linked) {
      if (!currentGroup) currentGroup = `g_${Date.now()}_${i}`;
      group = currentGroup;
      /* propagate group back to previous row's alert if not yet grouped */
      const prev = out[out.length - 1];
      if (prev && !prev.group) prev.group = currentGroup;
    } else {
      currentGroup = null;
    }
    const base = { type, dir, ...(ma !== undefined ? { ma } : {}), ...(group ? { group } : {}) };
    if (ALERT_NO_THRESHOLD.has(type)) { out.push({ ...base, threshold: null }); return; }
    const th = row.querySelector(".al-th").value;
    if (th === "" || isNaN(+th)) return;
    out.push({ ...base, threshold: +th });
  });
  return out;
}

function renderTradeEditor(trades) {
  const host = $("#edit-trades-list"); if (!host) return;
  if (!trades.length) { host.innerHTML = ""; return; }
  host.innerHTML =
    `<div class="trade-row__labels"><span>Typ</span><span>Datum</span><span>Kurs</span><span>Stück</span><span></span></div>` +
    trades.map((tr, i) => `<div class="trade-row" data-idx="${i}">
      <select class="tr-type">
        <option value="buy"  ${(tr.type||"buy")==="buy" ?"selected":""}>Buy</option>
        <option value="sell" ${tr.type==="sell"          ?"selected":""}>Sell</option>
      </select>
      <input class="tr-date"   type="date"   value="${tr.date   || ""}" />
      <input class="tr-price"  type="number" step="any" value="${tr.price  ?? ""}" placeholder="Kurs" />
      <input class="tr-shares" type="number" step="any" value="${tr.shares ?? ""}" placeholder="Stück" />
      <button class="tr-del" aria-label="Löschen">✕</button>
    </div>`).join("");
  host.querySelectorAll(".tr-del").forEach(b => b.addEventListener("click", e => e.currentTarget.closest(".trade-row").remove()));
}

function collectTradesFromEditor() {
  return $$("#edit-trades-list .trade-row").map((row, i) => {
    const price  = row.querySelector(".tr-price").value;
    if (!price) return null;
    return {
      id:     `tr_${Date.now()}_${i}`,
      type:   row.querySelector(".tr-type").value,
      date:   row.querySelector(".tr-date").value   || null,
      price:  +price,
      shares: row.querySelector(".tr-shares").value ? +row.querySelector(".tr-shares").value : null
    };
  }).filter(Boolean);
}

function _autoInitTrade(t) {
  if (t.user.bucket !== "portfolio") return;
  if ((t.user.trades || []).length) return;
  if (!t.user.entry_price_manual) return;
  t.user.trades = [{ id: `tr_auto_${Date.now()}`, type: "buy", date: null, price: t.user.entry_price_manual, shares: t.user.entry_shares || null }];
}

function _buildArchiveEntries() {
  const entries = [];
  for (const t of Store.state.tickers) {
    const trades = [...(t.user.trades || [])].sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });
    if (!trades.length) continue;
    let runningShares = 0, runningCost = 0;
    for (const tr of trades) {
      if (tr.type === "buy" && tr.price != null && tr.shares != null) {
        runningShares += tr.shares;
        runningCost   += tr.price * tr.shares;
      } else if (tr.type === "sell" && tr.shares != null) {
        const avgCost = runningShares > 0 ? +(runningCost / runningShares).toFixed(4) : null;
        const pl_abs  = (tr.price != null && avgCost != null)
          ? +((tr.price - avgCost) * tr.shares).toFixed(2) : null;
        entries.push({ t, tr, pl_abs, avgCost });
        const sold = Math.min(tr.shares, runningShares);
        if (runningShares > 0) {
          runningCost   -= (runningCost / runningShares) * sold;
          runningShares -= sold;
        }
        if (runningShares <= 0) { runningShares = 0; runningCost = 0; }
      }
    }
  }
  return entries.sort((a, b) => (b.tr.date || "").localeCompare(a.tr.date || ""));
}

function exportArchiveCsv() {
  const entries = _buildArchiveEntries();
  if (!entries.length) { toast("Keine realisierten Gewinne vorhanden", "neg"); return; }
  const header = ["Symbol","Name","Datum","Kurs","Stück","Ø Einstand","P/L abs"];
  const rows = entries.map(({ t, tr, pl_abs, avgCost }) => [
    t.stamm.symbol, t.stamm.name || "", tr.date || "",
    tr.price   != null ? String(tr.price).replace(".", ",")   : "",
    tr.shares  != null ? String(tr.shares).replace(".", ",")  : "",
    avgCost    != null ? String(avgCost).replace(".", ",")    : "",
    pl_abs     != null ? String(pl_abs).replace(".", ",")     : ""
  ]);
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `trades_${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

const ARCH_COLS = [
  { key: "symbol",  label: "Symbol",     val: e => e.t.stamm.symbol },
  { key: "name",    label: "Name",       val: e => e.t.stamm.name || "" },
  { key: "date",    label: "Datum",      val: e => e.tr.date || "" },
  { key: "price",   label: "Kurs",       val: e => e.tr.price },
  { key: "shares",  label: "Stück",      val: e => e.tr.shares },
  { key: "avgcost", label: "Ø Einstand", val: e => e.avgCost },
  { key: "pl",      label: "P/L abs",    val: e => e.pl_abs },
];
let _archSort = { col: "date", dir: -1 };

function renderArchiveView() {
  const host = $("#portfolio-archive-root"); if (!host) return;
  let entries = _buildArchiveEntries();
  if (!entries.length) {
    host.innerHTML = `<div class="tcard__empty">Noch keine Trades vorhanden.<br><span class="dim" style="font-size:12px">Trades werden im Edit-Modal unter "Trade-Historie" erfasst.</span></div>`;
    return;
  }
  const col = ARCH_COLS.find(c => c.key === _archSort.col);
  if (col) entries = [...entries].sort((a, b) => {
    const va = col.val(a) ?? "", vb = col.val(b) ?? "";
    return (va < vb ? -1 : va > vb ? 1 : 0) * _archSort.dir;
  });
  const totalPl = entries.reduce((s, e) => s + (e.pl_abs || 0), 0);
  const thArrow = key => key === _archSort.col ? (_archSort.dir === 1 ? " ↑" : " ↓") : "";
  host.innerHTML = `
    <div class="arch-summary">
      <span>Realisiert gesamt: <span class="${signCls(totalPl)}">${signedNum(totalPl, 0, "€")}</span>
        <span class="dim" style="font-size:var(--fs-l);margin-left:6px">${entries.length} Verkäufe</span>
      </span>
      <button class="btn-text" id="btn-arch-csv" style="margin-left:auto">
        <i data-lucide="download" class="icon icon-sm"></i>
        <span class="btn-text__label">CSV</span>
      </button>
    </div>
    <table class="arch-table">
      <thead><tr>${ARCH_COLS.map(c => `<th data-archcol="${c.key}" style="cursor:pointer">${c.label}${thArrow(c.key)}</th>`).join("")}</tr></thead>
      <tbody>${entries.map(({ t, tr, pl_abs, avgCost }) => `<tr>
        <td><span class="sym-strong">${t.stamm.symbol}</span></td>
        <td class="dim">${t.stamm.name || "—"}</td>
        <td class="dim">${tr.date || "—"}</td>
        <td>${numFmt(tr.price)}</td>
        <td>${tr.shares != null ? numFmt(tr.shares, 0) : "—"}</td>
        <td class="dim">${avgCost != null ? numFmt(avgCost) : "—"}</td>
        <td class="${signCls(pl_abs)}">${pl_abs != null ? signedNum(pl_abs, 0, "€") : "—"}</td>
      </tr>`).join("")}
      </tbody>
    </table>`;
  host.querySelector("thead").addEventListener("click", e => {
    const th = e.target.closest("th[data-archcol]"); if (!th) return;
    const key = th.dataset.archcol;
    _archSort = { col: key, dir: _archSort.col === key ? -_archSort.dir : 1 };
    renderArchiveView();
  });
  $("#btn-arch-csv")?.addEventListener("click", exportArchiveCsv);
  if (window.lucide) lucide.createIcons();
}

function switchPfTab(tab) {
  $$(".pf-tab").forEach(b => b.classList.toggle("is-active", b.dataset.pftab === tab));
  $("#portfolio-perf-root").hidden    = tab !== "perf";
  $("#portfolio-archive-root").hidden = tab !== "archive";
  if (tab === "archive") renderArchiveView();
}

function saveEdit() {
  const id = Store.state.ui.editingId; if (!id) return;
  const t = Store.byId(id); if (!t) return;
  t.user.bucket   = $("#edit-bucket").value;
  t.user.priority = $("#edit-priority").value || null;
  const ep = $("#edit-entry-price").value;
  t.user.entry_price_manual = ep === "" ? null : +ep;
  const sh = $("#edit-entry-shares").value;
  t.user.entry_shares = sh === "" ? null : +sh;
  t.user.notes = $("#edit-notes").value;
  t.user.tags  = collectTagsFromEditor();
  const tdSym = $("#edit-td-symbol").value.trim();
  const tdMic = $("#edit-td-mic").value.trim();
  const ySym  = $("#edit-yahoo-symbol").value.trim();
  if (tdSym) t.stamm.twelvedata_symbol = tdSym;
  if (tdMic) t.stamm.twelvedata_mic_code = tdMic;
  t.stamm.yahoo_symbol = ySym || null;
  const tvUrl = $("#edit-tv-url").value.trim();
  const stUrl = $("#edit-st-url").value.trim();
  t.stamm.tradingview_url = tvUrl || null;
  t.stamm.stocktwits_url  = stUrl || null;
  /* if user picked a lookup result, also propagate exchange + currency */
  const choice = Store.state.ui.tdLookupChoice;
  if (choice) {
    if (choice.exchange) t.stamm.twelvedata_exchange = choice.exchange;
    if (choice.currency) t.stamm.currency = choice.currency;
    Store.patchUi({ tdLookupChoice: null });
  }
  t.user.alerts = collectAlertsFromEditor();
  if (t.user.bucket === "portfolio") {
    t.user.trades = collectTradesFromEditor();
    // Chronological running cost basis — handles position close + reopen correctly
    const sorted = [...(t.user.trades || [])].sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1; if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });
    let runningShares = 0, runningCost = 0;
    sorted.forEach(tr => {
      if (tr.type === "buy" && tr.price != null && tr.shares != null) {
        runningShares += tr.shares;
        runningCost   += tr.price * tr.shares;
      } else if (tr.type === "sell" && tr.shares != null) {
        const sold = Math.min(tr.shares, runningShares);
        if (runningShares > 0) {
          runningCost   -= (runningCost / runningShares) * sold;
          runningShares -= sold;
        }
        if (runningShares <= 0) { runningShares = 0; runningCost = 0; }
      }
    });
    if (runningShares > 0) {
      t.user.entry_price_manual = +(runningCost / runningShares).toFixed(4);
      t.user.entry_shares = +runningShares.toFixed(4);
    } else {
      t.user.entry_price_manual = null;
      t.user.entry_shares = 0;
    }
  }
  _autoInitTrade(t);
  Calc.recompute(t);
  Store.save();
  Render.bucket();
  closeModal("#modal-edit");
  toast("Gespeichert", "pos");
}
function deleteEntry() {
  const id = Store.state.ui.editingId; if (!id) return;
  if (!confirm("Eintrag wirklich löschen?")) return;
  Store.remove(id);
  Store.patchUi({ editingId: null, selected: Store.state.ui.selected.filter(x => x !== id) });
  closeModal("#modal-edit");
  Render.all();
  toast("Gelöscht", "neg");
}

/* ─── TAG EDITOR ─── */
const MAX_TAGS = 6;
let _editTags = [];

function renderTagEditor(tags) {
  _editTags = [...(tags || [])].slice(0, MAX_TAGS);
  _renderTagPills();
}

function _renderTagPills() {
  const wrap = $("#edit-tags-wrap");
  wrap.innerHTML = _editTags.map((tag, i) =>
    `<span class="tag-pill">${escapeHtml(tag)}<button class="tag-pill__x" data-idx="${i}" title="Entfernen">&times;</button></span>`
  ).join("");
  wrap.querySelectorAll(".tag-pill__x").forEach(btn => {
    btn.addEventListener("click", () => {
      _editTags.splice(+btn.dataset.idx, 1);
      _renderTagPills();
    });
  });
  $("#edit-tags").disabled = _editTags.length >= MAX_TAGS;
}

function _addTag(raw) {
  const tag = raw.trim().toLowerCase().slice(0, 30);
  if (!tag || _editTags.includes(tag) || _editTags.length >= MAX_TAGS) return;
  _editTags.push(tag);
  _renderTagPills();
  $("#edit-tags").value = "";
}

function collectTagsFromEditor() { return [..._editTags]; }

/* ─── BULK TAG ─── */
function bulkTagPrompt() {
  const sel = Store.state.ui.selected;
  if (!sel.length) return;
  const tag = prompt("Tag zuweisen (leer = entfernen):");
  if (tag === null) return;
  const clean = tag.trim().toLowerCase().slice(0, 30);
  sel.forEach(id => {
    const t = Store.byId(id);
    if (!t) return;
    if (!Array.isArray(t.user.tags)) t.user.tags = [];
    if (clean === "") return;
    if (!t.user.tags.includes(clean) && t.user.tags.length < MAX_TAGS) t.user.tags.push(clean);
  });
  Store.save();
  Render.bucket();
  toast(clean ? `Tag "${clean}" → ${sel.length} Ticker` : "Tags nicht geändert", "pos");
}

/* ─── NACHKAUF modal ─── */
function openNachkauf(id) {
  const t = Store.byId(id); if (!t) return;
  Store.patchUi({ nachkaufId: id });
  $("#modal-nk-title").textContent = `${t.stamm.symbol} · Kalkulator`;
  const entry  = t.user.entry_price_manual;
  const shares = t.user.entry_shares;
  const price  = flat(t).price; // EUR-konvertiert
  $("#nk-context").innerHTML = `Einstand <b>${entry != null ? numFmt(entry) : "—"}</b> · Stück <b>${shares != null ? numFmt(shares, 0) : "—"}</b> · Live <b>${numFmt(price)}</b>`;
  $("#nk-type").value  = "buy";
  $("#nk-pct").value   = CONFIG.defaults.nkPct;
  $("#nk-price").value = price != null ? price : "";
  recomputeNachkauf();
  openModal("#modal-nachkauf");
}
function recomputeNachkauf() {
  const id   = Store.state.ui.nachkaufId;
  const t    = id && Store.byId(id);
  const out  = $("#nk-out");
  if (!t) { out.innerHTML = ""; return; }
  const type   = $("#nk-type").value;
  const entry  = t.user.entry_price_manual;
  const shares = t.user.entry_shares;
  const pct    = +$("#nk-pct").value;
  const price  = +$("#nk-price").value;

  const pctLbl   = type === "buy" ? "Aufstockung %" : "Verkauf %";
  const priceLbl = type === "buy" ? "Nachkauf-Kurs" : "Verkaufskurs";
  $("#nk-pct-label").textContent   = pctLbl;
  $("#nk-price-label").textContent = priceLbl;

  if (!shares || isNaN(pct) || !price) {
    out.innerHTML = `<div class="nk-out__row"><span class="nk-out__lbl">Hinweis</span><span class="nk-out__val dim">Stück und Kurs erforderlich</span></div>`;
    return;
  }

  if (type === "buy") {
    if (entry == null) { out.innerHTML = `<div class="nk-out__row"><span class="nk-out__lbl">Hinweis</span><span class="nk-out__val dim">Einstand erforderlich für Buy-Kalkulation</span></div>`; return; }
    const oldValue  = entry * shares;
    const addValue  = oldValue * (pct / 100);
    const addShares = addValue / price;
    const newShares = shares + addShares;
    const newValue  = oldValue + addValue;
    const newAvg    = newValue / newShares;
    const liveValue = flat(t).price != null ? newShares * flat(t).price : null;
    const newPL     = liveValue != null ? liveValue - newValue : null;
    out.innerHTML = `
      <div class="nk-out__row"><span class="nk-out__lbl">+ Investiert</span><span class="nk-out__val">${numFmt(addValue)}</span></div>
      <div class="nk-out__row"><span class="nk-out__lbl">+ Stück</span><span class="nk-out__val">${numFmt(addShares, 4)}</span></div>
      <div class="nk-out__row"><span class="nk-out__lbl">Neuer Ø-Einstand</span><span class="nk-out__val">${numFmt(newAvg)}</span></div>
      <div class="nk-out__row"><span class="nk-out__lbl">Neue Position</span><span class="nk-out__val">${numFmt(newShares, 4)} St · ${numFmt(newValue)}</span></div>
      ${liveValue != null ? `
        <div class="nk-out__row"><span class="nk-out__lbl">Live-Wert</span><span class="nk-out__val">${numFmt(liveValue)}</span></div>
        <div class="nk-out__row"><span class="nk-out__lbl">P/L danach</span><span class="nk-out__val ${signCls(newPL)}">${numFmt(newPL)}</span></div>
      ` : ""}`;
  } else {
    const sellShares    = shares * (pct / 100);
    const proceeds      = sellShares * price;
    const remainShares  = shares - sellShares;
    const costBase      = entry != null ? entry * shares : null;
    const pl            = costBase != null ? proceeds - (entry * sellShares) : null;
    const liveRemain    = flat(t).price != null ? remainShares * flat(t).price : null;
    out.innerHTML = `
      <div class="nk-out__row"><span class="nk-out__lbl">Verkauf Stück</span><span class="nk-out__val">${numFmt(sellShares, 4)}</span></div>
      <div class="nk-out__row"><span class="nk-out__lbl">Erlös</span><span class="nk-out__val">${numFmt(proceeds)}</span></div>
      ${pl != null ? `<div class="nk-out__row"><span class="nk-out__lbl">P/L realisiert</span><span class="nk-out__val ${signCls(pl)}">${pl >= 0 ? "+" : ""}${numFmt(pl)}</span></div>` : ""}
      <div class="nk-out__row"><span class="nk-out__lbl">Verbleibend</span><span class="nk-out__val">${numFmt(remainShares, 4)} St${liveRemain != null ? " · " + numFmt(liveRemain) : ""}</span></div>`;
  }
}
function setNachkaufAlert() {
  const id = Store.state.ui.nachkaufId;
  const t  = id && Store.byId(id); if (!t) return;
  const type    = $("#nk-type").value;
  const price   = +$("#nk-price").value; if (!price) { toast("Kein Kurs eingegeben", "neg"); return; }
  const pct     = +$("#nk-pct").value;
  const shares  = t.user.entry_shares;
  const nkShares = shares && pct ? +(shares * (type === "sell" ? pct / 100 : (t.user.entry_price_manual != null ? (t.user.entry_price_manual * shares * pct / 100) / price : 0))).toFixed(4) : null;
  const alertType = type === "buy" ? "price_below" : "price_above";
  const alert = { type: alertType, threshold: price, nk_side: type, ...(nkShares ? { nk_shares: nkShares } : {}) };
  t.user.alerts = [...(t.user.alerts || []), alert];
  Calc.recompute(t);
  Store.save();
  toast(`Alert ${type === "buy" ? "≤" : "≥"} ${numFmt(price)} gesetzt`, "pos");
}

/* ─── IMPORT JSON ─── */
/* normalizeImportItem(raw) → { stamm, user, quotes } | null
   Accepts 3 shapes:
   1) Schema-A:        { id?, stamm:{symbol,...}, user?, quotes? }
   2) Trend-Scout:     { symbol, name, exchange, sector, core_business, trend_reason, recent_news, next_catalysts, why_not, sentiment, priority, twelvedata_*, tradingview_url, ... }
   3) Minimal/flat:    { symbol, exchange?, ... }
   Stamm-fields stay in stamm (incl. core_business etc. — eff() falls back to them).
   user-block keeps override-slots null, sets bucket/priority/notes from import if present.
*/
const STAMM_FIELDS = [
  "symbol","name","exchange","asset_type","sector","sub_sector","market_cap_size",
  "currency","core_business","trend_reason","recent_news","next_catalysts","why_not",
  "tradingview_url","stocktwits_url","twelvedata_symbol","twelvedata_mic_code","twelvedata_exchange",
  "yahoo_symbol"
];
const USER_FIELDS = [
  "marked_at","scan_date","bucket","priority","status","notes","tags",
  "entry_price_manual","entry_shares","entry_price_start","alerts"
];

/* fields that — when present at top-level of a flat import — belong in user not stamm */
const FLAT_TO_USER = ["priority","bucket","notes","tags","entry_price_manual","entry_shares","scan_date","status"];

/* Helper: pluck a subset of fields out of an object, dropping null/undefined */
function pluck(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] != null) out[k] = obj[k];
  return out;
}

/* Screener-Discovery candidate → flat import shape.
   Lifts nested links/sources into known top-level fields so the generic
   flat-import path can pick them up. Non-destructive (shallow copy). */
function flattenDiscoveryCandidate(c) {
  const out = { ...c };
  if (c.links) {
    if (c.links.tradingview && out.tradingview_url == null) out.tradingview_url = c.links.tradingview;
    if (c.links.stocktwits  && out.stocktwits_url  == null) out.stocktwits_url  = c.links.stocktwits;
  }
  if (Array.isArray(c.sources) && c.sources.length) {
    const snippets = [...new Set(c.sources.map(s => s && s.info_snippet).filter(Boolean))];
    if (snippets.length && out.trend_reason == null) out.trend_reason = snippets.join(" · ");
  }
  return out;
}

function normalizeImportItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  /* Screener-Discovery candidate: flatten nested links/sources first */
  if (!raw.stamm && (raw.links || raw.sources)) raw = flattenDiscoveryCandidate(raw);

  /* Shape 1: Schema A — already has stamm */
  if (raw.stamm && typeof raw.stamm === "object") {
    if (!raw.stamm.symbol) return null;
    return {
      id: raw.id || `${raw.stamm.symbol}_${raw.stamm.exchange || "X"}`,
      stamm: { ...raw.stamm },
      user:  raw.user  ? { ...raw.user }  : {},
      quotes: raw.quotes ? { ...raw.quotes } : null
    };
  }

  /* Shape 2/3: flat — must have a symbol */
  if (!raw.symbol) return null;

  const stamm = pluck(raw, STAMM_FIELDS);
  const user  = pluck(raw, FLAT_TO_USER);

  /* sentiment → not a schema-A field, but useful info: stash under user.tags or notes? 
     We park it as a note tag, only when no notes already given. */
  if (raw.sentiment && !user.notes) {
    user.notes = `Sentiment: ${raw.sentiment}`;
  }

  /* TD-Exchange fallback: trend-scout writes "twelvedata_exchange": "XETRA" or "Stockholm" — keep as is */

  return {
    id: `${stamm.symbol}_${stamm.exchange || "X"}`,
    stamm,
    user,
    quotes: null
  };
}

function importJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) { toast("JSON ungültig: " + err.message, "neg"); return; }

  /* unwrap supported envelope shapes */
  let items;
  if (Array.isArray(parsed))                                     items = parsed;
  else if (Array.isArray(parsed.tickers))                        items = parsed.tickers;
  else if (Array.isArray(parsed.results))                        items = parsed.results;   // Trend-Scout
  else if (Array.isArray(parsed.candidates))                     items = parsed.candidates; // Screener-Discovery
  else if (Array.isArray(parsed.data))                           items = parsed.data;       // generic
  else if (typeof parsed === "object")                           items = [parsed];          // single-object
  else                                                           items = [];

  let added = 0, updated = 0, skipped = 0;
  const skippedSyms = [];

  for (const raw of items) {
    const norm = normalizeImportItem(raw);
    if (!norm) {
      skipped++;
      if (raw && (raw.symbol || (raw.stamm && raw.stamm.symbol))) {
        skippedSyms.push(raw.symbol || raw.stamm.symbol);
      }
      continue;
    }

    const existing = Store.byId(norm.id);
    if (existing) {
      /* merge: only overwrite stamm fields that are actually present in import,
         keep existing data (e.g. earlier news arrays) intact otherwise */
      for (const [k, v] of Object.entries(norm.stamm)) {
        if (v != null) existing.stamm[k] = v;
      }
      /* user block: shallow-merge defined fields only, never wipe entry_price_manual etc. */
      for (const [k, v] of Object.entries(norm.user || {})) {
        if (v != null) existing.user[k] = v;
      }
      if (norm.quotes) {
        for (const [k, v] of Object.entries(norm.quotes)) {
          if (v != null) existing.quotes[k] = v;
        }
      }
      Calc.recompute(existing);
      updated++;
    } else {
      const t = {
        id: norm.id,
        stamm: norm.stamm,
        user: Object.assign({
          marked_at: Date.now(), bucket: "neutral", priority: null, status: "aktiv",
          notes: "", tags: [], entry_price_manual: null, entry_shares: null,
          entry_price_start: null, alerts: [], trades: [],
          /* Schema-A user-block has override-SLOTS for these — stay null so eff() falls back to stamm */
          core_business: null, trend_reason: null, recent_news: null,
          next_catalysts: null, why_not: null
        }, norm.user),
        quotes: Object.assign(emptyQuotes(), norm.quotes || {}),
        calculations: emptyCalcs()
      };
      Calc.recompute(t);
      Store.upsert(t);
      added++;
    }
  }
  Store.save();
  Render.all();

  const parts = [];
  if (added)   parts.push(`${added} neu`);
  if (updated) parts.push(`${updated} aktualisiert`);
  if (skipped) parts.push(`${skipped} ignoriert${skippedSyms.length ? " ("+skippedSyms.slice(0,3).join(", ")+(skippedSyms.length>3?"…":"")+")" : ""}`);
  const msg = parts.length ? "Import: " + parts.join(", ") : "Import: nichts importiert";
  toast(msg, (added + updated) > 0 ? "pos" : "neg");
}

/* ─── EXPORT JSON (selection → clipboard) ─── */
async function exportJson() {
  const sel = Store.state.ui.selected;
  const items = sel.length
    ? Store.state.tickers.filter(t => sel.includes(t.id))
    : Store.state.tickers.filter(t => t.user.bucket === Store.state.ui.bucket);
  const json = JSON.stringify(items, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    toast(`${items.length} Einträge in Zwischenablage`, "pos");
  } catch {
    // fallback: prompt
    window.prompt("Kopiere JSON manuell:", json);
  }
}

/* ─── BULK ACTIONS ─── */
function bulkMoveToBucket(targetBucket) {
  const ids = Store.state.ui.selected;
  if (!ids.length) { toast("Nichts ausgewählt", "neg"); return; }
  let moved = 0, skipped = 0;
  for (const id of ids) {
    const t = Store.byId(id); if (!t) { skipped++; continue; }
    if (t.user.bucket === targetBucket) { skipped++; continue; }
    t.user.bucket = targetBucket;
    _autoInitTrade(t);
    moved++;
  }
  /* moved tickers might have left current view → drop them from selection */
  Store.patchUi({ selected: Store.state.ui.selected.filter(id => {
    const t = Store.byId(id);
    return t && t.user.bucket === Store.state.ui.bucket;
  })});
  Store.save();
  Render.bucket();
  Render.bulkbar();
  const msg = moved
    ? `${moved} → ${targetBucket}${skipped ? ` (${skipped} bereits drin)` : ""}`
    : `Alle bereits in ${targetBucket}`;
  toast(msg, moved > 0 ? "pos" : "neg");
}

function bulkDelete() {
  const ids = Store.state.ui.selected;
  if (!ids.length) { toast("Nichts ausgewählt", "neg"); return; }
  if (!confirm(`${ids.length} Einträge wirklich löschen?`)) return;
  for (const id of ids) Store.remove(id);
  Store.patchUi({ selected: [] });
  Render.bucket();
  Render.bulkbar();
  toast(`${ids.length} gelöscht`, "neg");
}

/* ─── REFRESH ─── */
async function refreshOne(id) {
  const t = Store.byId(id); if (!t) return;
  try {
    await API.fetchEurUsd();
    await API.refreshOne(t);
    Calc.recompute(t); Store.save(); Render.bucket();
    toast(`${t.stamm.symbol} aktualisiert`, "pos");
  } catch (err) { toast("Refresh fehlgeschlagen: " + err.message, "neg"); }
}
/* Bulk-Bar refresh (requires selection):
   ⟳  → Yahoo flat + TD flat — nur Kurs/Day-Change
   ⟳↓ → Yahoo full + TD full — Kurs + Historie/Indikatoren */
function bulkRefresh() {
  const ui = Store.state.ui;
  if (!ui.selected.length) { toast("Keine Auswahl", "neg"); return; }
  const list = Store.state.tickers.filter(t => ui.selected.includes(t.id));
  smartRefresh({ scope: "selected", tickers: list, tdMode: "flat", yahooMode: "flat", clearSel: true });
}
function bulkRefreshFull() {
  const ui = Store.state.ui;
  if (!ui.selected.length) { toast("Keine Auswahl", "neg"); return; }
  const list = Store.state.tickers.filter(t => ui.selected.includes(t.id));
  smartRefresh({ scope: "selected", tickers: list, tdMode: "full", yahooMode: "full", clearSel: true });
}

function setRefreshLoading(on) {
  ["#btn-element-refresh","#btn-element-fullrefresh","#bulk-refresh","#bulk-refresh-full"].forEach(s => {
    const b = $(s); if (!b) return;
    b.classList.toggle("is-loading", on);
    b.disabled = on;
  });
}

/* ─── ALERTS OVERVIEW ─── */
function openAlertsOverview() {
  const tickers = Store.state.tickers;
  const items = [];
  for (const t of tickers) {
    const trigs = (t.calculations && t.calculations.smart_alerts) || [];
    if (!trigs.length) continue;
    const rate  = Store.state.config.eur_usd;
    const ccy   = t.quotes?.currency_returned || t.stamm?.currency || "";
    const toEur = v => (ccy === "USD" && rate && v != null) ? +(v / rate).toFixed(4) : v;
    const eq = {
      ...t.quotes,
      price: toEur(t.quotes?.price),
      ma20:  toEur(t.quotes?.ma20),
      ma50:  toEur(t.quotes?.ma50),
      ma200: toEur(t.quotes?.ma200),
      _perf_pct: t.calculations?.trends?.performance_pct ?? null,
    };
    for (const a of trigs) items.push({ t, a, dir: alertDir(a), dist: alertDistance(a, eq), eq });
  }
  /* sort: triggered → near → others */
  items.sort((x, y) => {
    if (x.a._trig !== y.a._trig) return x.a._trig ? -1 : 1;
    if (x.dist.near !== y.dist.near) return x.dist.near ? -1 : 1;
    const dx = x.dist.pct == null ? Infinity : Math.abs(x.dist.pct);
    const dy = y.dist.pct == null ? Infinity : Math.abs(y.dist.pct);
    return dx - dy;
  });
  const body = $("#modal-alerts-body");
  if (!items.length) {
    body.innerHTML = `<div class="alert-overview__empty">Keine Alerts definiert</div>`;
    openModal("#modal-alerts"); return;
  }
  const groups = { buy: [], sell: [], watch: [] };
  items.forEach(it => (groups[it.dir] || groups.watch).push(it));
  const sectionLbl = { buy: "Buy-Signale", sell: "Sell-Signale", watch: "Beobachten" };

  const renderItem = ({ t, a, dir, dist, eq }) => {
    let typeLabel, valLabel, unit = "%";
    if (a.type === "price_below")        { typeLabel = "Preis ≤";      valLabel = numFmt(a.threshold); }
    else if (a.type === "price_above")   { typeLabel = "Preis ≥";      valLabel = numFmt(a.threshold); }
    else if (a.type === "perf_below")    { typeLabel = `Perf ≤ −${a.threshold}%`; valLabel = eq._perf_pct != null ? `aktuell ${eq._perf_pct >= 0 ? "+" : ""}${eq._perf_pct.toFixed(1)}%` : "—"; unit = "pp"; }
    else if (a.type === "perf_above")    { typeLabel = `Perf ≥ +${a.threshold}%`; valLabel = eq._perf_pct != null ? `aktuell ${eq._perf_pct >= 0 ? "+" : ""}${eq._perf_pct.toFixed(1)}%` : "—"; unit = "pp"; }
    else if (a.type === "rsi_below")     { typeLabel = "RSI ≤"; valLabel = `${a.threshold} (aktuell ${eq.rsi != null ? eq.rsi.toFixed(0) : "—"})`; unit = "pp"; }
    else if (a.type === "rsi_above")     { typeLabel = "RSI ≥"; valLabel = `${a.threshold} (aktuell ${eq.rsi != null ? eq.rsi.toFixed(0) : "—"})`; unit = "pp"; }
    else if (a.type === "ma20_below")    { typeLabel = "Preis ≤ MA20";  valLabel = eq.ma20  != null ? numFmt(eq.ma20)  : "—"; }
    else if (a.type === "ma50_below")    { typeLabel = "Preis ≤ MA50";  valLabel = eq.ma50  != null ? numFmt(eq.ma50)  : "—"; }
    else if (a.type === "ma200_below")   { typeLabel = "Preis ≤ MA200"; valLabel = eq.ma200 != null ? numFmt(eq.ma200) : "—"; }
    else if (a.type === "ma_below_pct" || a.type === "ma_above_pct") {
      const maName = (a.ma || "ma50").toUpperCase();
      const sign   = a.type === "ma_above_pct" ? "+" : "−";
      typeLabel = `Preis ${a.type==="ma_above_pct"?"≥":"≤"} ${maName} ${sign}${a.threshold}%`;
      const mv  = a.ma ? eq[a.ma] : null;
      const abs = mv != null ? +(mv * (a.type==="ma_above_pct" ? 1 + a.threshold/100 : 1 - a.threshold/100)).toFixed(2) : null;
      valLabel  = abs != null ? numFmt(abs) : "—";
    }
    else if (a.type === "macd_bullish")  { typeLabel = "MACD bullisch"; valLabel = eq.macd_histogram != null ? `Hist ${eq.macd_histogram >= 0 ? "+" : ""}${eq.macd_histogram.toFixed(3)}` : "—"; }
    else if (a.type === "macd_bearish")  { typeLabel = "MACD bärisch";  valLabel = eq.macd_histogram != null ? `Hist ${eq.macd_histogram >= 0 ? "+" : ""}${eq.macd_histogram.toFixed(3)}` : "—"; }
    else if (a.type === "reversal_up_short")   { typeLabel = "Trendwende ↑ kurzfristig (MACD)";  valLabel = "—"; }
    else if (a.type === "reversal_down_short") { typeLabel = "Trendwende ↓ kurzfristig (MACD)";  valLabel = "—"; }
    else if (a.type === "reversal_up_long")    { typeLabel = "Trendwende ↑ langfristig (MA200)"; valLabel = "—"; }
    else if (a.type === "reversal_down_long")  { typeLabel = "Trendwende ↓ langfristig (MA200)"; valLabel = "—"; }
    else if (a.type === "vol_spike")     { typeLabel = "Volumen Spike ≥"; valLabel = a.threshold != null ? `${a.threshold}×Ø` : "—"; }
    else                                 { typeLabel = a.type; valLabel = numFmt(a.threshold); }

    const distLbl = a._trig
      ? `<span class="alert-overview__status is-trig">⚠ ausgelöst</span>`
      : dist.pct != null
        ? `<span class="alert-overview__status ${dist.near ? "is-near" : "dim"}">${dist.pct >= 0 ? "+" : ""}${dist.pct.toFixed(1)} ${unit}</span>`
        : "";
    const grp = a.group ? `<span class="alert-overview__grp" title="AND-Gruppe">&</span>` : "";
    return `<div class="alert-overview__item alert-overview__item--${dir} ${a._trig ? "is-trig" : ""}">
      <span class="alert-overview__sym">${t.stamm.symbol}${grp}</span>
      <span class="alert-overview__type">${typeLabel}</span>
      <span class="alert-overview__val">${valLabel}</span>
      ${distLbl}
    </div>`;
  };
  body.innerHTML = ["buy","sell","watch"].filter(k => groups[k].length).map(k => `
    <div class="alert-overview__section alert-overview__section--${k}">
      <div class="alert-overview__head">${sectionLbl[k]} <span class="dim">· ${groups[k].length}</span></div>
      ${groups[k].map(renderItem).join("")}
    </div>`).join("");
  openModal("#modal-alerts");
}

/* ─── BLOB CLOUD STORAGE (Netlify Blobs via /.netlify/functions/blob) ─── */
async function saveBlob(btn) {
  if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
  try {
    const payload = {
      tickers: Store.state.tickers,
      savedAt: Date.now(),
      version: 1
    };
    const res = await fetch(CONFIG.blob.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${txt ? ": " + txt.slice(0, 80) : ""}`);
    }
    toast("In Cloud gespeichert", "pos");
  } catch (err) {
    toast("Cloud-Save fehlgeschlagen: " + err.message, "neg");
    console.warn("[blob:save]", err);
  } finally {
    if (btn) { btn.classList.remove("is-loading"); btn.disabled = false; }
  }
}

/* loadBlob: on app start, fetches cloud copy and merges if newer than local */
async function loadBlob({ silent = true } = {}) {
  try {
    const res = await fetch(CONFIG.blob.endpoint, { method: "GET" });
    if (res.status === 404) {
      if (!silent) toast("Noch keine Cloud-Daten vorhanden", "neg");
      return false;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.tickers)) {
      if (!silent) toast("Cloud-Daten ungültig", "neg");
      return false;
    }
    /* policy: cloud wins if newer than local lastSavedAt OR local is empty */
    const localTickers = Store.state.tickers.length;
    const localTs = Store.state.ui.lastSyncTs || 0;
    const cloudTs = data.savedAt || 0;
    if (localTickers === 0 || cloudTs > localTs) {
      Store.state.tickers = data.tickers;
      Calc.recomputeAll();
      Store.patchUi({ lastSyncTs: cloudTs, selected: [] });
      Render.all();
      if (!silent) toast(`${data.tickers.length} aus Cloud geladen`, "pos");
      else console.log(`[blob:load] ${data.tickers.length} tickers from cloud (savedAt: ${new Date(cloudTs).toLocaleString("de-DE")})`);
      return true;
    } else {
      if (!silent) toast("Lokale Daten sind aktueller — kein Load", "neg");
      console.log("[blob:load] skipped (local newer)");
      return false;
    }
  } catch (err) {
    console.warn("[blob:load]", err);
    if (!silent) toast("Cloud-Load fehlgeschlagen: " + err.message, "neg");
    return false;
  }
}

/* ─── DISCOVERY IMPORT (Screener-Discovery export via proxy function) ─── */
async function importFromDiscovery(btn) {
  if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
  try {
    const res = await fetch(CONFIG.discovery.endpoint, { method: "GET" });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error || ""; } catch { /* non-JSON (z.B. GitHub-Pages 404) */ }
      throw new Error(`HTTP ${res.status}${detail ? ": " + detail : ""}`);
    }
    const data = await res.json();
    const list = Array.isArray(data?.candidates) ? data.candidates
               : Array.isArray(data)             ? data
               : null;
    if (!list || !list.length) { toast("Keine Discovery-Kandidaten gefunden", "neg"); return; }
    importJson(JSON.stringify(data));   // reuse unified import path (unwraps candidates)
  } catch (err) {
    toast("Discovery-Import fehlgeschlagen: " + err.message, "neg");
    console.warn("[discovery:import]", err);
  } finally {
    if (btn) { btn.classList.remove("is-loading"); btn.disabled = false; }
  }
}

/* ─── CONFIG modal ─── */
function openConfig() {
  $("#cfg-twelvedata").value = Store.state.config.twelveDataKey || "";
  const rate = Store.state.config.eur_usd;
  const rateEl = $("#cfg-eur-usd-info");
  if (rateEl) rateEl.textContent = rate ? `EUR/USD: ${rate.toFixed(4)}` : "EUR/USD: nicht geladen";
  openModal("#modal-config");
}
function saveConfig() {
  Store.patchConfig({ twelveDataKey: $("#cfg-twelvedata").value.trim() });
  closeModal("#modal-config");
  toast("API-Key gespeichert", "pos");
}

/* ─── TD SYMBOL LOOKUP (Edit modal) ─── */
async function tdLookup() {
  const btn = $("#edit-td-lookup");
  const host = $("#edit-td-results");
  const status = $("#edit-td-status");
  const query = ($("#edit-td-symbol").value.trim() || (Store.byId(Store.state.ui.editingId)?.stamm.symbol || "")).trim();
  if (!query) { toast("Symbol eingeben für Lookup", "neg"); return; }

  btn.classList.add("is-loading"); btn.disabled = true;
  host.hidden = false;
  host.innerHTML = `<div class="td-result__empty">Suche nach "${escapeHtml(query)}"…</div>`;
  status.hidden = true;

  try {
    const results = await API.tdSymbolSearch(query);
    if (!results.length) {
      host.innerHTML = `<div class="td-result__empty">Keine Treffer für "${escapeHtml(query)}"</div>`;
      return;
    }
    host.innerHTML = results.map((r, i) => `
      <div class="td-result" data-idx="${i}">
        <span class="td-result__sym">${escapeHtml(r.symbol || "—")}</span>
        <span class="td-result__name" title="${escapeHtml(r.name || "")}">${escapeHtml(r.name || "—")}</span>
        <span class="td-result__meta">${escapeHtml(r.exchange || "")}${r.mic_code ? " · "+escapeHtml(r.mic_code) : ""}${r.currency ? " · "+escapeHtml(r.currency) : ""}</span>
      </div>
    `).join("");
    host.querySelectorAll(".td-result").forEach(el => {
      el.addEventListener("click", () => applyTdLookupResult(results[+el.dataset.idx]));
    });
  } catch (err) {
    host.innerHTML = `<div class="td-result__empty">Fehler: ${escapeHtml(err.message)}</div>`;
  } finally {
    btn.classList.remove("is-loading"); btn.disabled = false;
  }
}

function applyTdLookupResult(r) {
  const t = Store.byId(Store.state.ui.editingId); if (!t) return;
  /* update inputs in modal */
  $("#edit-td-symbol").value = r.symbol || "";
  $("#edit-td-mic").value    = r.mic_code || "";
  /* highlight chosen result */
  const results = $$(".td-result");
  results.forEach(el => el.classList.remove("is-active"));
  const active = [...results].find(el => el.querySelector(".td-result__sym").textContent === r.symbol);
  if (active) active.classList.add("is-active");
  /* status line */
  const status = $("#edit-td-status");
  status.hidden = false;
  status.className = "modal__hint is-pos";
  const parts = [];
  if (r.exchange) parts.push("Börse: " + r.exchange);
  if (r.mic_code) parts.push("MIC: " + r.mic_code);
  if (r.currency) parts.push("Währung: " + r.currency);
  status.textContent = `Übernommen: ${r.symbol}${parts.length ? " (" + parts.join(", ") + ")" : ""} — Änderungen werden beim Speichern wirksam`;
  /* note for saveEdit to also propagate exchange + currency */
  Store.patchUi({ tdLookupChoice: { exchange: r.exchange, currency: r.currency, mic_code: r.mic_code, symbol: r.symbol } });
}

/* ════════════════════════════════════════════════════
   BIND EVENTS
   ════════════════════════════════════════════════════ */
function bindEvents() {
  // top bar
  $("#btn-blob")       .addEventListener("click", e => saveBlob(e.currentTarget));
  $("#btn-json-import").addEventListener("click", () => openModal("#modal-import"));
  $("#btn-discovery-import").addEventListener("click", e => importFromDiscovery(e.currentTarget));
  $("#btn-json-export").addEventListener("click", exportJson);
  $("#menu-nav")       .addEventListener("click", () => { Store.patchUi({ menuOpen: !Store.state.ui.menuOpen }); Render.menu(); });

  // sub bar
  $("#btn-element-card-view") .addEventListener("click", () => { Store.patchUi({ view: "cards" }); Render.viewMode(); });
  $("#btn-element-table-view").addEventListener("click", () => { Store.patchUi({ view: "table" }); Render.viewMode(); });
  $("#btn-element-refresh")     .addEventListener("click", () => smartRefresh({ scope: "active", tdMode: "flat" }));
  $("#btn-element-fullrefresh") .addEventListener("click", () => smartRefresh({ scope: "active", tdMode: "full" }));

  // tag input in edit modal
  $("#edit-tags").addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); _addTag(e.target.value); }
  });
  $("#edit-tags").addEventListener("blur", e => { if (e.target.value.trim()) _addTag(e.target.value); });

  // bulkbar
  $("#bulk-tag")           .addEventListener("click", bulkTagPrompt);
  $("#bulk-refresh")     .addEventListener("click", bulkRefresh);
  $("#bulk-refresh-full").addEventListener("click", bulkRefreshFull);
  $("#bulk-delete") .addEventListener("click", bulkDelete);
  $$(".bulkbar__btn[data-bucket]").forEach(btn => {
    btn.addEventListener("click", () => bulkMoveToBucket(btn.dataset.bucket));
  });

  // bottom nav
  $("#nav-bottom-element-home").addEventListener("click", () => {
    const next = Store.state.ui.activeView === "portfolio" ? "screener" : "portfolio";
    Store.patchUi({ triggeredOnly: false, selected: [] });
    switchView(next);
  });
  $("#nav-bottom-element-alert").addEventListener("click", openAlertsOverview);
  $("#nav-bottom-element-dropdown").addEventListener("change", e => {
    Store.patchUi({ bucket: e.target.value, selected: [] });
    Render.bucket(); Render.bulkbar();
  });

  // side menu
  $("#menu-nav-btn-screener")  .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); switchView("screener"); });
  $("#menu-nav-btn-dashboard") .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); switchView("dashboard"); });
  $("#menu-nav-btn-portfolio") .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); switchView("portfolio"); });
  $("#menu-nav-btn-analyse")  .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); switchView("analyse"); });
  document.addEventListener("click", e => {
    const tab = e.target.closest(".pf-tab");
    if (tab) switchPfTab(tab.dataset.pftab);
  });
  $("#menu-nav-btn-config")   .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); openConfig(); });
  $("#menu-nav-btn-cloud-load").addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); loadBlob({ silent: false }); });
  $("#menu-nav-btn-cloud-save").addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); saveBlob(null); });
  $("#menu-nav-btn-console")  .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); window.eruda?.show(); });
  $("#nav-sheet-close")       .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); });
  $("#nav-scrim")             .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); });

  // dark mode
  $("#btn-dark-mode").addEventListener("click", () => {
    const isDark = document.documentElement.dataset.theme === "dark";
    const next = isDark ? "" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next || "light");
    _updateDarkIcon();
  });

  // info modal — prompt selector
  const promptSel = $("#info-prompt-select");
  if (promptSel && typeof window.PROMPTS !== "undefined") {
    window.PROMPTS.forEach(p => {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.label;
      promptSel.appendChild(o);
    });
    promptSel.addEventListener("change", updatePromptText);
  }
  $("#btn-copy-prompt").addEventListener("click", () => {
    const ta = $("#info-prompt-text");
    if (!ta.value) return;
    navigator.clipboard.writeText(ta.value).then(() => toast("Prompt kopiert", "pos"));
  });

  $("#btn-info-import").addEventListener("click", () => {
    const status = $("#info-import-status");
    const raw = $("#info-import-json").value.trim();
    if (!raw) return;
    let json;
    try { json = JSON.parse(raw); } catch { status.textContent = "Ungültiges JSON"; status.hidden = false; return; }
    const t = _currentInfoTicker && Store.byId(_currentInfoTicker.id);
    if (!t) return;
    const STAMM_FIELDS = ["trend_reason","recent_news","next_catalysts","sentiment","why_not","core_business","sector","sub_sector","market_cap_size"];
    let updated = 0;
    for (const key of STAMM_FIELDS) {
      if (key in json) { t.stamm[key] = json[key]; updated++; }
    }
    if ("priority" in json) { t.user.priority = json.priority; updated++; }
    if (!updated) { status.textContent = "Keine bekannten Felder im JSON"; status.hidden = false; return; }
    Calc.recompute(t); Store.save(); Render.bucket();
    status.textContent = `${updated} Feld${updated > 1 ? "er" : ""} übernommen`;
    status.hidden = false;
    $("#info-import-json").value = "";
    openInfo(_currentInfoTicker.id);
  });

  // modal: generic close
  $$("[data-modal-close]").forEach(el => el.addEventListener("click", e => closeModal(e.currentTarget.closest(".modal"))));
  document.addEventListener("keydown", e => { if (e.key === "Escape") $$(".modal").forEach(m => { if (!m.hidden) closeModal(m); }); });

  // edit
  $("#modal-edit-save")  .addEventListener("click", saveEdit);
  $("#modal-edit-delete").addEventListener("click", deleteEntry);
  $("#edit-td-lookup")   .addEventListener("click", tdLookup);
  $("#edit-alert-add")   .addEventListener("click", () => {
    const t = Store.byId(Store.state.ui.editingId); if (!t) return;
    const cur = collectAlertsFromEditor();
    cur.push({ type: "price_below", threshold: t.quotes.price || 0 });
    renderAlertEditor(cur, t);
  });
  $("#edit-trade-add").addEventListener("click", () => {
    const cur = collectTradesFromEditor();
    cur.push({ id: `tr_${Date.now()}`, type: "buy", date: new Date().toISOString().slice(0,10), price: null, shares: null });
    renderTradeEditor(cur);
  });
  $("#edit-bucket").addEventListener("change", () => {
    const isPortfolio = $("#edit-bucket").value === "portfolio";
    $("#edit-trades-section").hidden = !isPortfolio;
  });

  // nachkauf
  $("#nk-type") .addEventListener("change", recomputeNachkauf);
  $("#nk-pct")  .addEventListener("input",  recomputeNachkauf);
  $("#nk-price").addEventListener("input",  recomputeNachkauf);
  $("#btn-nk-alert").addEventListener("click", setNachkaufAlert);

  // import
  $("#modal-import-confirm").addEventListener("click", () => {
    const text = $("#import-json").value.trim();
    if (!text) { toast("Kein JSON eingegeben", "neg"); return; }
    importJson(text);
    closeModal("#modal-import");
    $("#import-json").value = "";
  });

  // config
  $("#modal-config-save").addEventListener("click", saveConfig);
  $("#modal-bench-save") .addEventListener("click", saveBenchSettings);
}

/* ════════════════════════════════════════════════════
   SECTION 7 — VIEW SWITCHING / DARK MODE / PORTFOLIO
   ════════════════════════════════════════════════════ */
let _currentInfoTicker = null;

function _updateDarkIcon() {
  const btn = $("#btn-dark-mode");
  if (!btn) return;
  const isDark = document.documentElement.dataset.theme === "dark";
  btn.innerHTML = isDark
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
}

function switchView(view) {
  Store.patchUi({ activeView: view });
  Render.viewMode();
  if (view === "portfolio") {
    const activeTab = $(".pf-tab.is-active")?.dataset?.pftab || "perf";
    if (activeTab === "archive") renderArchiveView();
    else renderPortfolioPerf();
  } else if (view === "dashboard") {
    renderDashboard();
  } else if (view === "analyse") {
    renderAnalyse();
  }
}

function updatePromptText() {
  if (!_currentInfoTicker || typeof window.PROMPTS === "undefined") return;
  const sel = $("#info-prompt-select");
  const prompt = window.PROMPTS.find(p => p.id === sel.value);
  if (!prompt) return;
  $("#info-prompt-text").value = fillPrompt(prompt.template, _currentInfoTicker);
}

function pfWaterfall(positions) {
  const sorted = [...positions].sort((a, b) => (b.position_pl_abs || 0) - (a.position_pl_abs || 0));
  const maxAbs = Math.max(...sorted.map(t => Math.abs(t.position_pl_abs || 0)), 0.01);
  return `<div class="pf-section">
    <div class="pf-section__title">P/L je Position</div>
    <div class="pf-waterfall">
      ${sorted.map(t => {
        const pl = t.position_pl_abs;
        const w  = pl != null ? Math.max(2, Math.round(Math.abs(pl) / maxAbs * 100)) : 0;
        return `<div class="pf-wf-row">
          <span class="pf-wf-sym">${t.symbol}</span>
          <div class="pf-wf-track">
            <div class="pf-wf-bar ${signCls(pl)}" style="width:${w}%"></div>
          </div>
          <span class="pf-wf-val ${signCls(pl)}">${signedNum(pl, 0, "€")}</span>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function pfScatterMatrix(positions) {
  const pts = positions.filter(t => t.rsi != null && t.sentiment_score != null);
  if (!pts.length) return "";
  const W = 320, H = 190;
  const PL = 28, PR = 12, PT = 16, PB = 28;
  const iW = W - PL - PR, iH = H - PT - PB;
  const toX = s  => PL + ((Math.max(-1, Math.min(1, s)) + 1) / 2) * iW;
  const toY = r  => PT + (1 - Math.max(0, Math.min(100, r)) / 100) * iH;
  const qx  = toX(0), y70 = toY(70), y30 = toY(30);
  const quadLabels = [
    { x: PL + iW * 0.76, y: PT + 10, txt: "Stark & Heiß" },
    { x: PL + iW * 0.24, y: PT + 10, txt: "Überkauft" },
    { x: PL + iW * 0.76, y: H - PB - 6, txt: "Kaufzone" },
    { x: PL + iW * 0.24, y: H - PB - 6, txt: "Schwach" },
  ];
  const dots = pts.map(t => {
    const cx = toX(t.sentiment_score), cy = toY(t.rsi);
    const fill = t.performance_pct == null ? "var(--muted)" : t.performance_pct >= 0 ? "var(--pos)" : "var(--neg)";
    const labelX = cx + 7, labelY = cy + 3;
    return `<g>
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${fill}" opacity=".85"/>
      <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" font-size="9" font-family="DM Sans,sans-serif" fill="var(--text)">${t.symbol}</text>
    </g>`;
  }).join("");
  return `<div class="pf-section">
    <div class="pf-section__title">RSI · Sentiment Matrix</div>
    <div class="pf-scatter-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
        <rect x="${PL}" y="${PT}" width="${qx - PL}" height="${y70 - PT}" fill="var(--neg)" opacity=".04"/>
        <rect x="${qx}" y="${PT}" width="${PL + iW - qx}" height="${y70 - PT}" fill="var(--pos)" opacity=".06"/>
        <rect x="${PL}" y="${y30}" width="${qx - PL}" height="${PT + iH - y30}" fill="var(--muted)" opacity=".04"/>
        <rect x="${qx}" y="${y30}" width="${PL + iW - qx}" height="${PT + iH - y30}" fill="var(--accent)" opacity=".05"/>
        <line x1="${qx.toFixed(1)}" y1="${PT}" x2="${qx.toFixed(1)}" y2="${PT + iH}" stroke="var(--border)" stroke-width="1"/>
        <line x1="${PL}" y1="${y70.toFixed(1)}" x2="${PL + iW}" y2="${y70.toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"/>
        <line x1="${PL}" y1="${y30.toFixed(1)}" x2="${PL + iW}" y2="${y30.toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"/>
        <text x="${PL - 4}" y="${y70.toFixed(1)}" font-size="8" text-anchor="end" dominant-baseline="middle" fill="var(--muted)">70</text>
        <text x="${PL - 4}" y="${y30.toFixed(1)}" font-size="8" text-anchor="end" dominant-baseline="middle" fill="var(--muted)">30</text>
        <text x="${PL}" y="${H - 4}" font-size="8" fill="var(--muted)">Bearish</text>
        <text x="${PL + iW}" y="${H - 4}" font-size="8" text-anchor="end" fill="var(--muted)">Bullish</text>
        ${quadLabels.map(l => `<text x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" font-size="8" text-anchor="middle" fill="var(--muted)" opacity=".5">${l.txt}</text>`).join("")}
        ${dots}
      </svg>
    </div>
  </div>`;
}

function pfStrategySplit(allPortfolio) {
  const STRATS  = ["long", "swing", "breakout"];
  const LABELS  = { long: "Long", swing: "Swing", breakout: "Contrarian" };
  const COLORS  = { long: "#3A82C4", swing: "#6EC6E6", breakout: "#9B6DFF" };
  const targets = { long: 50, swing: 30, breakout: 20, ...Store.state.config.strategy_targets };
  const values  = { long: 0, swing: 0, breakout: 0 };
  allPortfolio.forEach(t => { if (t.priority in values) values[t.priority] += t.position_value || 0; });
  const totalVal = Object.values(values).reduce((s, v) => s + v, 0) || 1;

  // donut
  const CX = 56, CY = 56, RO = 46, RI = 26;
  let angle = -Math.PI / 2;
  const arc = (pct) => {
    const a = pct * 2 * Math.PI;
    const end = angle + a;
    const x1o = CX + RO * Math.cos(angle), y1o = CY + RO * Math.sin(angle);
    const x2o = CX + RO * Math.cos(end),   y2o = CY + RO * Math.sin(end);
    const x1i = CX + RI * Math.cos(angle), y1i = CY + RI * Math.sin(angle);
    const x2i = CX + RI * Math.cos(end),   y2i = CY + RI * Math.sin(end);
    const lg  = a > Math.PI ? 1 : 0;
    const d   = pct < 0.002 ? "" :
      `M${x1i.toFixed(1)},${y1i.toFixed(1)} L${x1o.toFixed(1)},${y1o.toFixed(1)} A${RO},${RO},0,${lg},1,${x2o.toFixed(1)},${y2o.toFixed(1)} L${x2i.toFixed(1)},${y2i.toFixed(1)} A${RI},${RI},0,${lg},0,${x1i.toFixed(1)},${y1i.toFixed(1)} Z`;
    angle = end;
    return d;
  };
  const paths = STRATS.map(s => ({ s, d: arc(values[s] / totalVal), color: COLORS[s] }));
  const donut = `<svg viewBox="0 0 112 112" width="112" height="112" style="flex-shrink:0">
    ${paths.map(p => p.d ? `<path d="${p.d}" fill="${p.color}" opacity=".85"/>` : "").join("")}
    <text x="${CX}" y="${CY - 5}" text-anchor="middle" font-size="11" font-weight="700" font-family="DM Mono,monospace" fill="var(--text)">${numFmt(totalVal, 0)}</text>
    <text x="${CX}" y="${CY + 10}" text-anchor="middle" font-size="8" font-family="DM Sans,sans-serif" fill="var(--muted)">€ investiert</text>
  </svg>`;

  const rows = STRATS.map(s => {
    const actual  = Math.round((values[s] / totalVal) * 100);
    const tgt     = targets[s] || 0;
    const diff    = actual - tgt;
    const diffCls = diff > 5 ? "pos" : diff < -5 ? "neg" : "dim";
    return `<div class="pf-split__row">
      <span class="pf-split__lbl" style="color:${COLORS[s]}">${LABELS[s]}</span>
      <div class="pf-split__bars">
        <div class="pf-split__bar-wrap">
          <div class="pf-split__bar" style="width:${actual}%;background:${COLORS[s]}"></div>
          <span class="pf-split__pct">${actual}%</span>
          <span class="pf-split__diff ${diffCls}" title="Abweichung vom Ziel">${diff >= 0 ? "+" : ""}${diff}%</span>
        </div>
        <div class="pf-split__bar-wrap pf-split__bar-wrap--target">
          <div class="pf-split__bar pf-split__bar--target" style="width:${tgt}%;background:${COLORS[s]}"></div>
          <span class="pf-split__pct--target">Ziel <input class="pf-split__input" data-strat="${s}" type="number" min="0" max="100" value="${tgt}"/>%</span>
        </div>
      </div>
    </div>`;
  }).join("");

  return `<div class="pf-section">
    <div class="pf-section__title">Strategie-Mix</div>
    <div class="pf-split">
      <div class="pf-split__donut">${donut}</div>
      <div class="pf-split__detail">${rows}</div>
    </div>
  </div>`;
}

let _pfTreemapFilter = "all"; // "all" | "ETF" | "Aktie" etc.

function _pfTreemapSVG(positions, filter) {
  const filtered = filter === "all" ? positions : positions.filter(t => (t.asset_type || "").toLowerCase() === filter.toLowerCase());
  if (!filtered.length) return `<div class="an-empty">Keine Positionen für „${filter}"</div>`;
  const W = 340, H = 160;
  const treemap = buildTreemap(filtered, W, H);
  return `<svg class="pf-treemap" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    ${treemap.map(r => {
      const perf = r.performance_pct;
      const val  = r.position_value;
      const fill = perf == null ? "var(--border)" : perf >= 0 ? `rgba(53,133,53,${Math.min(0.2 + Math.abs(perf)/20, 0.9)})` : `rgba(239,66,66,${Math.min(0.2 + Math.abs(perf)/20, 0.9)})`;
      const fw = r.x2 - r.x1, fh = r.y2 - r.y1;
      return `<g>
        <rect x="${r.x1+1}" y="${r.y1+1}" width="${fw-2}" height="${fh-2}" rx="4" fill="${fill}" stroke="var(--bg)" stroke-width="2"/>
        ${fw > 40 && fh > 22 ? `<text x="${r.x1+fw/2}" y="${r.y1+fh/2-5}" text-anchor="middle" dominant-baseline="middle" fill="var(--text)" font-size="${Math.min(fw/6,13)}" font-weight="700" font-family="DM Sans,sans-serif">${r.symbol}</text>` : ""}
        ${fw > 40 && fh > 36 ? `<text x="${r.x1+fw/2}" y="${r.y1+fh/2+10}" text-anchor="middle" dominant-baseline="middle" fill="var(--text)" font-size="${Math.min(fw/7,10)}" font-family="DM Mono,monospace">${val != null ? numFmt(val, 0) + "€" : "—"}</text>` : ""}
      </g>`;
    }).join("")}
  </svg>`;
}

function _pfAssetStackedBar(positions) {
  const total = positions.reduce((s, t) => s + (t.position_value || 0), 0);
  if (!total) return "";
  const groups = new Map();
  positions.forEach(t => {
    const key = t.asset_type || "Sonstige";
    groups.set(key, (groups.get(key) || 0) + (t.position_value || 0));
  });
  const COLORS = { "ETF": "#3A82C4", "Aktie": "#6EC6E6", "Sonstige": "#9B6DFF" };
  const DEFAULT_COLORS = ["#F59E0B","#10B981","#EC4899","#EF4444","#8B5CF6"];
  let ci = 0;
  const segments = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([label, val]) => {
    const pct = (val / total) * 100;
    const color = COLORS[label] || DEFAULT_COLORS[ci++ % DEFAULT_COLORS.length];
    return { label, val, pct, color };
  });

  const bar = segments.map(s =>
    `<div class="pf-sbar__seg" style="width:${s.pct.toFixed(2)}%;background:${s.color}" title="${s.label}: ${s.pct.toFixed(1)}% · ${numFmt(s.val, 0)}€"></div>`
  ).join("");

  const legend = segments.map(s =>
    `<div class="pf-sbar__leg">
      <span class="pf-sbar__dot" style="background:${s.color}"></span>
      <span class="pf-sbar__lbl">${s.label}</span>
      <span class="pf-sbar__pct">${s.pct.toFixed(1)}%</span>
      <span class="pf-sbar__val dim">${numFmt(s.val, 0)}€</span>
    </div>`
  ).join("");

  return `<div class="pf-section">
    <div class="pf-section__title">ETF / Aktie Split</div>
    <div class="pf-sbar">${bar}</div>
    <div class="pf-sbar__legends">${legend}</div>
  </div>`;
}

function renderPortfolioPerf() {
  const host = $("#portfolio-perf-root");
  if (!host) return;
  const allPortfolio = Store.state.tickers
    .filter(t => t.user.bucket === "portfolio")
    .map(t => flat(t));
  const positions = allPortfolio.filter(t => t.position_value != null);

  if (!allPortfolio.length) {
    host.innerHTML = `<div class="tcard__empty">Keine Portfolio-Positionen vorhanden.</div>`;
    return;
  }

  const assetTypes = [...new Set(positions.map(t => t.asset_type).filter(Boolean))].sort();
  const tmTabs = ["all", ...assetTypes].map(f => {
    const label = f === "all" ? "Alle" : f;
    const active = _pfTreemapFilter === f ? " is-active" : "";
    return `<button class="fpill${active}" data-pf-tm="${f}">${label}</button>`;
  }).join("");

  // C1: summary filtered by treemap pill
  const filteredPos = _pfTreemapFilter === "all" ? positions : positions.filter(t => (t.asset_type || "").toLowerCase() === _pfTreemapFilter.toLowerCase());
  const totalValue = filteredPos.reduce((s, t) => s + (t.position_value  || 0), 0);
  const totalCost  = filteredPos.reduce((s, t) => s + ((t.entry_price_manual || 0) * (t.entry_shares || 0)), 0);
  const totalPlAbs = filteredPos.reduce((s, t) => s + (t.position_pl_abs || 0), 0);
  const totalPlPct = totalCost > 0 ? (totalPlAbs / totalCost) * 100 : null;

  // C3: ETF/Aktie stacked bar
  const assetSplit = _pfAssetStackedBar(positions);

  host.innerHTML = `
    <div class="pf-section">
      <div class="pf-section__title">
        ${_pfTreemapFilter === "all" ? "Gesamt" : _pfTreemapFilter}
        <span class="pf-section__pills">${tmTabs}</span>
      </div>
      <div class="pf-summary">
        <div class="pf-summary__kpi">
          <span class="pf-summary__label">Gesamtwert</span>
          <span class="pf-summary__val">${numFmt(totalValue)}</span>
        </div>
        <div class="pf-summary__kpi">
          <span class="pf-summary__label">P/L gesamt</span>
          <span class="pf-summary__val ${signCls(totalPlAbs)}">${signedNum(totalPlAbs, 0)} (${totalPlPct != null ? signedNum(totalPlPct, 2, "%") : "—"})</span>
        </div>
      </div>
      <div class="pf-treemap-wrap" id="pf-treemap-host">${_pfTreemapSVG(positions, _pfTreemapFilter)}</div>
    </div>
    ${assetSplit}
    ${positions.length ? pfWaterfall(positions) : ""}
    ${positions.length ? pfScatterMatrix(positions) : ""}
    ${pfStrategySplit(allPortfolio)}`;

  host.querySelectorAll("[data-pf-tm]").forEach(btn => {
    btn.addEventListener("click", () => {
      _pfTreemapFilter = btn.dataset.pfTm;
      renderPortfolioPerf();
    });
  });
  host.querySelectorAll(".pf-split__input").forEach(inp => {
    inp.addEventListener("change", () => {
      const targets = Store.state.config.strategy_targets || {};
      host.querySelectorAll(".pf-split__input").forEach(el => {
        targets[el.dataset.strat] = Math.max(0, Math.min(100, +el.value || 0));
      });
      Store.patchConfig({ strategy_targets: targets });
      renderPortfolioPerf();
    });
  });
}

function buildTreemap(positions, W, H) {
  const total = positions.reduce((s, t) => s + Math.max(t.position_value || 0, 0.01), 0);
  const items = positions.map(t => ({ ...t, area: (Math.max(t.position_value||0,0.01)/total)*W*H }))
    .sort((a,b) => b.area - a.area);
  const rects = [];
  squarify(items, { x1:0, y1:0, x2:W, y2:H }, rects);
  return rects;
}
function squarify(items, box, out) {
  if (!items.length) return;
  const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
  const totalArea = items.reduce((s,i) => s + i.area, 0);
  let row = [], rowArea = 0;
  const ratio = (row, w) => {
    const a = row.reduce((s,i) => s + i.area, 0);
    const maxA = Math.max(...row.map(i => i.area));
    const minA = Math.min(...row.map(i => i.area));
    return Math.max((w*w*maxA)/(a*a), (a*a)/(w*w*minA));
  };
  const horiz = bw >= bh;
  const w = horiz ? bh : bw;
  let i = 0;
  while (i < items.length) {
    const next = [...row, items[i]];
    if (row.length && ratio(next, w) > ratio(row, w)) break;
    row = next; rowArea += items[i].area; i++;
  }
  // lay out row
  const frac = rowArea / totalArea;
  let pos = horiz ? box.y1 : box.x1;
  const rowEnd = horiz ? box.x1 + bw * frac : box.y1 + bh * frac;
  for (const item of row) {
    const itemFrac = item.area / rowArea;
    const s = (horiz ? bh : bw) * itemFrac;
    const r = horiz
      ? { x1: pos, y1: box.y1, x2: pos + (rowEnd-box.x1), y2: box.y1 + bh * (item.area/rowArea) * (row.length) }
      : { x1: box.x1, y1: pos, x2: box.x1 + bw * (item.area/rowArea) * (row.length), y2: pos + (rowEnd-box.y1) };
    // simpler slice layout
    if (horiz) {
      const cellH = bh * (item.area / rowArea);
      out.push({ ...item, x1: box.x1, y1: pos, x2: rowEnd, y2: pos + cellH });
      pos += cellH;
    } else {
      const cellW = bw * (item.area / rowArea);
      out.push({ ...item, x1: pos, y1: box.y1, x2: pos + cellW, y2: rowEnd });
      pos += cellW;
    }
  }
  // recurse on remaining
  const rest = items.slice(i);
  if (rest.length) {
    const newBox = horiz
      ? { x1: rowEnd, y1: box.y1, x2: box.x2, y2: box.y2 }
      : { x1: box.x1, y1: rowEnd, x2: box.x2, y2: box.y2 };
    squarify(rest, newBox, out);
  }
}

/* ════════════════════════════════════════════════════
   SECTION 8 — DASHBOARD
   ════════════════════════════════════════════════════ */

function _avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function _dashRows() {
  return Store.state.tickers
    .map(t => ({ t, f: flat(t) }))
    .filter(r => r.f.price != null);
}

function _pos52w(f) {
  if (f.price != null && f.high_52w != null && f.low_52w != null && f.high_52w > f.low_52w)
    return (f.price - f.low_52w) / (f.high_52w - f.low_52w) * 100;
  return null;
}

/* I — Kanban KPIs */
function _dashKanban(rows) {
  const buckets = ["portfolio", "watchlist", "neutral"];
  const labels  = { portfolio: "Portfolio", watchlist: "Watchlist", neutral: "Neutral" };
  const cards = buckets.map(b => {
    const br  = rows.filter(r => r.f.bucket === b);
    const cnt = br.length;
    const avgRsi = _avg(br.map(r => r.f.rsi).filter(v => v != null));
    const avgChg = _avg(br.map(r => r.f.day_change_pct).filter(v => v != null));
    const trig   = br.filter(r => r.f.alert_triggered).length;
    const chgCls = avgChg == null ? "" : avgChg >= 0 ? "pos" : "neg";
    const chgLbl = avgChg == null ? "—" : (avgChg >= 0 ? "+" : "") + avgChg.toFixed(1) + "%";
    const trigHtml = trig > 0 ? `<span class="dash-kpi__trig">${trig} Alert${trig > 1 ? "s" : ""}</span>` : "";
    return `<div class="dash-kpi">
      <div class="dash-kpi__head">
        <span class="dash-kpi__label">${labels[b]}</span>
        <span class="dash-kpi__count">${cnt}</span>
      </div>
      <div class="dash-kpi__stats">
        <span>Ø RSI <b>${avgRsi != null ? avgRsi.toFixed(0) : "—"}</b></span>
        <span>Ø Tag <b class="${chgCls}">${chgLbl}</b></span>
        ${trigHtml}
      </div>
    </div>`;
  });
  return `<div class="dash-section">
    <div class="dash-section__title">Übersicht</div>
    <div class="dash-kanban">${cards.join("")}</div>
  </div>`;
}

/* H — MA-Alignment Heatmap */
function _dashHeatmap(rows) {
  const sorted = [...rows].sort((a, b) =>
    a.f.bucket.localeCompare(b.f.bucket) || (a.f.symbol || "").localeCompare(b.f.symbol || "")
  );
  const MAS  = ["ma20", "ma50", "ma200"];
  const LABS = ["MA20", "MA50", "MA200"];
  const withData = sorted.filter(r => MAS.some(ma => r.f[ma] != null)).length;
  const head = LABS.map(l => `<th class="dhm__th">${l}</th>`).join("");
  const body = sorted.map(r => {
    const cells = MAS.map(ma => {
      const above = r.f[ma] != null && r.f.price != null ? r.f.price > r.f[ma] : null;
      const cls = above === null ? "dhm__cell--na" : above ? "dhm__cell--up" : "dhm__cell--dn";
      const title = r.f[ma] != null ? r.f[ma].toFixed(2) : "kein Datenabruf";
      const inner = above === null ? "—" : "";
      return `<td class="dhm__cell ${cls}" title="${title}">${inner}</td>`;
    }).join("");
    const bucketDot = `<span class="dhm__dot dhm__dot--${r.f.bucket}"></span>`;
    return `<tr><td class="dhm__sym">${bucketDot}${r.f.symbol}</td>${cells}</tr>`;
  }).join("");
  return `<div class="dash-section dash-section--half">
    <div class="dash-section__title">MA-Alignment <span class="dash-count">${withData}/${sorted.length}</span></div>
    <div class="dhm-wrap">
      <table class="dhm">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </div>`;
}

/* S — RSI · Sentiment Matrix (Watchlist) */
function _dashSentimentMatrix(rows) {
  const pts = rows
    .filter(r => r.f.bucket === "watchlist" && r.f.rsi != null)
    .map(r => ({ sym: r.f.symbol, rsi: r.f.rsi, sent: r.f.sentiment_score ?? 0 }));

  if (!pts.length) return `<div class="dash-section dash-section--half">
    <div class="dash-section__title">RSI · Sentiment</div>
    <div class="dash-empty">Watchlist ohne RSI-Daten (Full-Refresh erforderlich)</div>
  </div>`;

  const W = 280, H = 180;
  const PL = 28, PR = 12, PT = 14, PB = 26;
  const iW = W - PL - PR, iH = H - PT - PB;
  const toX = s => PL + ((Math.max(-1, Math.min(1, s)) + 1) / 2) * iW;
  const toY = r => PT + (1 - Math.max(0, Math.min(100, r)) / 100) * iH;
  const qx = toX(0), y70 = toY(70), y30 = toY(30);
  const quadLabels = [
    { x: PL + iW * 0.76, y: PT + 10,      txt: "Stark & Heiß" },
    { x: PL + iW * 0.24, y: PT + 10,      txt: "Überkauft"    },
    { x: PL + iW * 0.76, y: H - PB - 6,   txt: "Kaufzone"     },
    { x: PL + iW * 0.24, y: H - PB - 6,   txt: "Schwach"      },
  ];
  const dots = pts.map(p => {
    const cx = toX(p.sent), cy = toY(p.rsi);
    const fill = p.rsi < 30 ? "var(--pos)" : p.rsi > 70 ? "var(--neg)" : "var(--accent)";
    return `<g>
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${fill}" opacity=".82"/>
      <text x="${(cx+7).toFixed(1)}" y="${(cy+3).toFixed(1)}" font-size="9" font-family="DM Sans,sans-serif" fill="var(--text)">${p.sym}</text>
    </g>`;
  }).join("");

  return `<div class="dash-section dash-section--half">
    <div class="dash-section__title">RSI · Sentiment <span class="dash-count">${pts.length}</span></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
      <rect x="${PL}" y="${PT}" width="${(qx-PL).toFixed(1)}" height="${(y70-PT).toFixed(1)}" fill="var(--neg)" opacity=".04"/>
      <rect x="${qx.toFixed(1)}" y="${PT}" width="${(PL+iW-qx).toFixed(1)}" height="${(y70-PT).toFixed(1)}" fill="var(--pos)" opacity=".06"/>
      <rect x="${PL}" y="${y30.toFixed(1)}" width="${(qx-PL).toFixed(1)}" height="${(PT+iH-y30).toFixed(1)}" fill="var(--muted)" opacity=".04"/>
      <rect x="${qx.toFixed(1)}" y="${y30.toFixed(1)}" width="${(PL+iW-qx).toFixed(1)}" height="${(PT+iH-y30).toFixed(1)}" fill="var(--accent)" opacity=".05"/>
      <line x1="${qx.toFixed(1)}" y1="${PT}" x2="${qx.toFixed(1)}" y2="${(PT+iH).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
      <line x1="${PL}" y1="${y70.toFixed(1)}" x2="${(PL+iW).toFixed(1)}" y2="${y70.toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"/>
      <line x1="${PL}" y1="${y30.toFixed(1)}" x2="${(PL+iW).toFixed(1)}" y2="${y30.toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${(PL-4)}" y="${y70.toFixed(1)}" font-size="8" text-anchor="end" dominant-baseline="middle" fill="var(--muted)">70</text>
      <text x="${(PL-4)}" y="${y30.toFixed(1)}" font-size="8" text-anchor="end" dominant-baseline="middle" fill="var(--muted)">30</text>
      <text x="${PL}" y="${H-4}" font-size="8" fill="var(--muted)">Bearish</text>
      <text x="${(PL+iW)}" y="${H-4}" font-size="8" text-anchor="end" fill="var(--muted)">Bullish</text>
      ${quadLabels.map(l => `<text x="${l.x.toFixed(1)}" y="${l.y}" font-size="8" text-anchor="middle" fill="var(--muted)" opacity=".5">${l.txt}</text>`).join("")}
      ${dots}
    </svg>
    <div class="dash-legend">
      <span class="dash-legend__dot" style="background:var(--pos)"></span>RSI &lt;30
      <span class="dash-legend__dot" style="background:var(--accent)"></span>Neutral
      <span class="dash-legend__dot" style="background:var(--neg)"></span>RSI &gt;70
    </div>
  </div>`;
}

/* K — 52W × RSI Scatter + Matrix */
function _dashScatter(rows) {
  const pts = rows.map(r => {
    const p52 = _pos52w(r.f);
    return r.f.rsi != null && p52 != null
      ? { sym: r.f.symbol, rsi: r.f.rsi, p52, bucket: r.f.bucket }
      : null;
  }).filter(Boolean);
  const countLabel = pts.length ? ` <span class="dash-count">${pts.length}</span>` : "";

  const W = 260, H = 170, PL = 32, PR = 8, PT = 8, PB = 28;
  const iw = W - PL - PR, ih = H - PT - PB;
  const BCOL = { portfolio: "var(--accent)", watchlist: "var(--pos)", neutral: "var(--muted)" };
  const dots = pts.map(p => {
    const cx = (PL + (p.rsi / 100) * iw).toFixed(1);
    const cy = (PT + (1 - p.p52 / 100) * ih).toFixed(1);
    const col = BCOL[p.bucket] || "var(--muted)";
    return `<circle cx="${cx}" cy="${cy}" r="4" fill="${col}" opacity="0.75"><title>${p.sym} RSI=${p.rsi.toFixed(0)} 52W=${p.p52.toFixed(0)}%</title></circle>`;
  }).join("");
  const rsiZoneX1 = (PL + 0.30 * iw).toFixed(1);
  const rsiZoneW  = (0.40 * iw).toFixed(1);
  const axisLabels = [
    `<text x="${(PL + 0.30*iw).toFixed(1)}" y="${H-PB+12}" font-size="9" fill="var(--muted)" text-anchor="middle">30</text>`,
    `<text x="${(PL + 0.70*iw).toFixed(1)}" y="${H-PB+12}" font-size="9" fill="var(--muted)" text-anchor="middle">70</text>`,
    `<text x="${(PL + 0.50*iw).toFixed(1)}" y="${H-PB+22}" font-size="9" fill="var(--muted)" text-anchor="middle">RSI →</text>`,
    `<text x="${(PL-6).toFixed(1)}" y="${(PT + ih*0.25).toFixed(1)}" font-size="9" fill="var(--muted)" text-anchor="end">75%</text>`,
    `<text x="${(PL-6).toFixed(1)}" y="${(PT + ih*0.75).toFixed(1)}" font-size="9" fill="var(--muted)" text-anchor="end">25%</text>`,
    `<text x="${(PL-6).toFixed(1)}" y="${(PT + ih*0.50).toFixed(1)}" font-size="9" fill="var(--muted)" text-anchor="end">50%</text>`,
  ].join("");
  const svgK2 = `<svg class="dash-scatter dash-k2" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <rect x="${rsiZoneX1}" y="${PT}" width="${rsiZoneW}" height="${ih}" fill="var(--surface)" rx="2"/>
    <line x1="${PL}" y1="${H-PB}" x2="${W-PR}" y2="${H-PB}" stroke="var(--line)" stroke-width="1"/>
    <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${H-PB}" stroke="var(--line)" stroke-width="1"/>
    ${axisLabels}
    ${dots}
  </svg>`;

  const RSI_BINS = [{lo:0,hi:30,label:"RSI<30"},{lo:30,hi:50,label:"30-50"},{lo:50,hi:70,label:"50-70"},{lo:70,hi:101,label:"RSI>70"}];
  const POS_BINS = [{lo:75,hi:101,label:">75%"},{lo:50,hi:75,label:"50-75%"},{lo:25,hi:50,label:"25-50%"},{lo:0,hi:25,label:"<25%"}];
  const matrix = POS_BINS.map(pb => RSI_BINS.map(rb =>
    pts.filter(p => p.rsi >= rb.lo && p.rsi < rb.hi && p.p52 >= pb.lo && p.p52 < pb.hi)
  ));
  const maxN = Math.max(1, ...matrix.flat().map(c => c.length));
  const matRows = POS_BINS.map((pb, ri) => `<tr>
    <td class="dk3__label">${pb.label}</td>
    ${RSI_BINS.map((rb, ci) => {
      const cell = matrix[ri][ci];
      const alpha = (cell.length / maxN * 0.65).toFixed(2);
      const bg = cell.length ? `rgba(80,120,220,${alpha})` : "transparent";
      const tip = cell.map(p => p.sym).join(", ") || "";
      return `<td class="dk3__cell" style="background:${bg}" title="${tip}">${cell.length || ""}</td>`;
    }).join("")}
  </tr>`).join("");
  const matrixHtml = `<table class="dash-k3" hidden>
    <thead><tr><th></th>${RSI_BINS.map(b => `<th class="dk3__th">${b.label}</th>`).join("")}</tr></thead>
    <tbody>${matRows}</tbody>
  </table>`;

  const legend = `<div class="dash-legend">
    <span class="dash-legend__dot" style="background:var(--accent)"></span>Portfolio
    <span class="dash-legend__dot" style="background:var(--pos)"></span>Watchlist
    <span class="dash-legend__dot" style="background:var(--muted)"></span>Neutral
  </div>`;

  return `<div class="dash-section dash-section--half">
    <div class="dash-section__head">
      <div class="dash-section__title">52W × RSI${countLabel}</div>
      <div class="dtog">
        <button class="dtog__btn is-active" data-k="k2">Scatter</button>
        <button class="dtog__btn" data-k="k3">Matrix</button>
      </div>
    </div>
    ${svgK2}
    ${matrixHtml}
    ${legend}
    ${pts.length === 0 ? '<div class="dash-empty">Keine Daten (RSI + 52W fehlt)</div>' : ""}
  </div>`;
}

/* L — Momentum 7T */
function _dashMomentum(rows) {
  const items = rows.map(r => {
    const l7 = r.f.last7d;
    if (!l7 || l7.length < 2 || !l7[0]) return null;
    return { sym: r.f.symbol, pct: (l7[l7.length-1] - l7[0]) / Math.abs(l7[0]) * 100 };
  }).filter(Boolean).sort((a, b) => b.pct - a.pct);

  if (!items.length) return `<div class="dash-section dash-section--half">
    <div class="dash-section__title">Momentum 7T</div><div class="dash-empty">Keine 7T-Daten (Full-Refresh erforderlich)</div></div>`;

  const maxAbs = Math.max(...items.map(m => Math.abs(m.pct)), 0.01);
  const bars = items.slice(0, 15).map(m => {
    const w = Math.max(1, Math.abs(m.pct) / maxAbs * 100).toFixed(0);
    const pos = m.pct >= 0;
    return `<div class="dash-bar">
      <div class="dash-bar__lbl">${m.sym}</div>
      <div class="dash-bar__track"><div class="dash-bar__fill ${pos ? "dash-bar__fill--pos" : "dash-bar__fill--neg"}" style="width:${w}%"></div></div>
      <div class="dash-bar__val ${pos ? "pos" : "neg"}">${pos ? "+" : ""}${m.pct.toFixed(1)}%</div>
    </div>`;
  }).join("");

  return `<div class="dash-section dash-section--half">
    <div class="dash-section__title">Momentum 7T <span class="dash-count">${items.length}</span></div>
    <div class="dash-bars">${bars}</div>
  </div>`;
}

/* M — Volatilität 7T */
function _dashVolatility(rows) {
  const items = rows.map(r => {
    const l7 = r.f.last7d;
    if (!l7 || l7.length < 2) return null;
    const rets = [];
    for (let i = 1; i < l7.length; i++) if (l7[i-1]) rets.push((l7[i] - l7[i-1]) / l7[i-1] * 100);
    if (!rets.length) return null;
    const mean = _avg(rets);
    const vol  = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length);
    return { sym: r.f.symbol, vol };
  }).filter(Boolean).sort((a, b) => b.vol - a.vol);

  if (!items.length) return `<div class="dash-section dash-section--half">
    <div class="dash-section__title">Volatilität 7T</div><div class="dash-empty">Keine 7T-Daten (Full-Refresh erforderlich)</div></div>`;

  const maxV = Math.max(...items.map(v => v.vol), 0.01);
  const bars = items.slice(0, 15).map(v => {
    const w = Math.max(1, v.vol / maxV * 100).toFixed(0);
    return `<div class="dash-bar">
      <div class="dash-bar__lbl">${v.sym}</div>
      <div class="dash-bar__track"><div class="dash-bar__fill dash-bar__fill--vol" style="width:${w}%"></div></div>
      <div class="dash-bar__val dim">${v.vol.toFixed(1)}%</div>
    </div>`;
  }).join("");

  return `<div class="dash-section dash-section--half">
    <div class="dash-section__title">Volatilität 7T <span class="dash-count">${items.length}</span></div>
    <div class="dash-bars">${bars}</div>
  </div>`;
}

/* O — Opportunity Score */
function _dashOpportunity(rows) {
  const BCOL = { portfolio: "var(--accent)", watchlist: "var(--pos)", neutral: "var(--muted)" };
  const scored = rows.map(r => {
    const f = r.f;
    let score = 0, n = 0;
    if (f.rsi != null)       { score += (1 - f.rsi / 100) * 35; n++; }
    const p52 = _pos52w(f);
    if (p52 != null)         { score += (1 - p52 / 100) * 30; n++; }
    if (f.last7d?.length >= 2 && f.last7d[0]) {
      const mom = (f.last7d[f.last7d.length-1] - f.last7d[0]) / Math.abs(f.last7d[0]) * 100;
      score += Math.max(-5, Math.min(5, mom)) * 0.5; n++;
    }
    if (n === 0) return null;
    return { sym: f.symbol, score, bucket: f.bucket };
  }).filter(Boolean).sort((a, b) => b.score - a.score);

  if (!scored.length) return `<div class="dash-section dash-section--half">
    <div class="dash-section__title">Opportunity Score</div><div class="dash-empty">Keine Daten</div></div>`;

  const maxS = scored[0].score;
  const bars = scored.slice(0, 10).map((s, i) => {
    const w = Math.max(1, s.score / maxS * 100).toFixed(0);
    const col = BCOL[s.bucket] || "var(--muted)";
    return `<div class="dash-bar">
      <div class="dash-bar__lbl">${i+1}. ${s.sym}</div>
      <div class="dash-bar__track"><div class="dash-bar__fill" style="width:${w}%;background:${col}"></div></div>
      <div class="dash-bar__val dim">${s.score.toFixed(0)}</div>
    </div>`;
  }).join("");

  return `<div class="dash-section dash-section--half">
    <div class="dash-section__title">Opportunity Score <span class="dash-count">${scored.length}</span></div>
    <div class="dash-bars">${bars}</div>
  </div>`;
}

function renderDashboard() {
  const rows = _dashRows();
  const el   = $("#dashboard-root");
  if (!el) return;

  el.innerHTML = `<div class="dash">
    ${_dashKanban(rows)}
    <div class="dash__grid2">
      ${_dashHeatmap(rows)}
      ${_dashSentimentMatrix(rows)}
    </div>
    <div class="dash__grid2">
      ${_dashScatter(rows)}
      ${_dashMomentum(rows)}
    </div>
    <div class="dash__grid2">
      ${_dashVolatility(rows)}
      ${_dashOpportunity(rows)}
    </div>
  </div>`;

  /* K2/K3 toggle */
  el.querySelectorAll(".dtog .dtog__btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tog = btn.closest(".dtog");
      tog.querySelectorAll(".dtog__btn").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const mode = btn.dataset.k;
      const sec  = btn.closest(".dash-section");
      sec.querySelector(".dash-k2").hidden = mode !== "k2";
      sec.querySelector(".dash-k3").hidden = mode !== "k3";
    });
  });
}

/* ════════════════════════════════════════════════════
   SECTION 8b — ANALYSE (B+D: Tags, Sektor, Size Screener)
   ════════════════════════════════════════════════════ */

let _analyseFilter = "all";
let _analyseAsset  = "";
let _analyseGroupBy = "tags";

function _analyseRows() {
  let rows = Store.state.tickers.map(t => ({ t, f: flat(t) })).filter(r => r.f.price != null);
  if (_analyseFilter === "portfolio") rows = rows.filter(r => r.f.bucket === "portfolio");
  else if (_analyseFilter === "watch") rows = rows.filter(r => r.f.bucket === "watchlist" || r.f.bucket === "neutral");
  if (_analyseAsset) rows = rows.filter(r => (r.f.asset_type || "").toLowerCase() === _analyseAsset.toLowerCase());
  return rows;
}

function _allTags() {
  const tags = new Set();
  Store.state.tickers.forEach(t => (t.user.tags || []).forEach(tag => tags.add(tag)));
  return [...tags].sort();
}

function _allAssetTypes() {
  const types = new Set();
  Store.state.tickers.forEach(t => { if (t.stamm.asset_type) types.add(t.stamm.asset_type); });
  return [...types].sort();
}

function _groupRows(rows, key) {
  const groups = new Map();
  rows.forEach(r => {
    let vals;
    if (key === "tags") {
      vals = (r.f.tags && r.f.tags.length) ? r.f.tags : ["(ohne Tag)"];
    } else if (key === "sector") {
      vals = [r.f.sector || "(ohne Sektor)"];
    } else {
      vals = [r.f.market_cap_size || "(ohne Size)"];
    }
    vals.forEach(v => {
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(r);
    });
  });
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

function _clusterMetrics(rows) {
  const vals = (field) => rows.map(r => r.f[field]).filter(v => v != null);
  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  return {
    count:      rows.length,
    perf_pct:   avg(vals("performance_pct")),
    sentiment:  avg(vals("sentiment_score")),
    rsi:        avg(vals("rsi")),
    month_pct:  avg(vals("month_change_pct")),
    ma50_delta: avg(vals("ma50_delta_pct")),
    ma200_delta:avg(vals("ma200_delta_pct")),
  };
}

function _heatCell(val) {
  if (val == null) return `<td class="an-heat an-heat--na">—</td>`;
  const alpha = Math.min(Math.abs(val) / 10, 0.85);
  const color = val >= 0 ? `rgba(53,133,53,${alpha.toFixed(2)})` : `rgba(239,66,66,${alpha.toFixed(2)})`;
  return `<td class="an-heat" style="background:${color}">${val >= 0 ? "+" : ""}${val.toFixed(1)}</td>`;
}

function _analyseTreemap(rows, label) {
  const W = 320, H = 140;
  const items = rows.map(r => {
    const w = r.f.bucket === "portfolio" && r.f.position_value ? r.f.position_value : 1;
    return { ...r.f, weight: Math.max(w, 0.01) };
  });
  const total = items.reduce((s, i) => s + i.weight, 0);
  const mapped = items.map(i => ({ ...i, area: (i.weight / total) * W * H })).sort((a, b) => b.area - a.area);
  const rects = [];
  squarify(mapped, { x1: 0, y1: 0, x2: W, y2: H }, rects);
  if (!rects.length) return "";
  return `<div class="an-treemap-wrap">
    <div class="an-treemap-label">${escapeHtml(label)}</div>
    <svg class="an-treemap" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      ${rects.map(r => {
        const m = r.month_change_pct;
        const fill = m == null ? "var(--border)" : m >= 0
          ? `rgba(53,133,53,${Math.min(0.2 + Math.abs(m) / 15, 0.9).toFixed(2)})`
          : `rgba(239,66,66,${Math.min(0.2 + Math.abs(m) / 15, 0.9).toFixed(2)})`;
        const fw = r.x2 - r.x1, fh = r.y2 - r.y1;
        return `<g>
          <rect x="${r.x1 + 1}" y="${r.y1 + 1}" width="${Math.max(fw - 2, 0)}" height="${Math.max(fh - 2, 0)}" rx="3" fill="${fill}" stroke="var(--bg)" stroke-width="1.5"/>
          ${fw > 36 && fh > 18 ? `<text x="${r.x1 + fw / 2}" y="${r.y1 + fh / 2}" text-anchor="middle" dominant-baseline="middle" fill="var(--text)" font-size="${Math.min(fw / 6, 11)}" font-weight="600" font-family="DM Sans,sans-serif">${r.symbol}</text>` : ""}
        </g>`;
      }).join("")}
    </svg>
  </div>`;
}

function _analyseGroupSection(label, rows) {
  const m = _clusterMetrics(rows);
  const treemap = rows.length > 1 ? _analyseTreemap(rows, label) : "";
  const tickers = rows.map(r => r.f.symbol).join(", ");
  return `<div class="an-group">
    <div class="an-group__head">
      <span class="an-group__label">${escapeHtml(label)}</span>
      <span class="an-group__count">${m.count}</span>
    </div>
    ${treemap}
    <div class="an-group__tickers">${escapeHtml(tickers)}</div>
  </div>`;
}

function renderAnalyse() {
  const host = $("#analyse-root");
  if (!host) return;
  const rows = _analyseRows();
  const assetTypes = _allAssetTypes();
  const grouped = _groupRows(rows, _analyseGroupBy);
  const groupLabels = { tags: "Tag-Cluster", sector: "Sektor", size: "Marktkapitalisierung" };

  const filterPills = ["all", "portfolio", "watch"].map(f => {
    const labels = { all: "Alle", portfolio: "Portfolio", watch: "Watch" };
    const active = _analyseFilter === f ? " is-active" : "";
    return `<button class="an-pill${active}" data-an-filter="${f}">${labels[f]}</button>`;
  }).join("");

  const assetOpts = [`<option value="">Alle Typen</option>`]
    .concat(assetTypes.map(a => `<option value="${a}"${_analyseAsset === a ? " selected" : ""}>${a}</option>`))
    .join("");

  const groupTabs = ["tags", "sector", "size"].map(g => {
    const labels = { tags: "Tags", sector: "Sektor", size: "Size" };
    const active = _analyseGroupBy === g ? " is-active" : "";
    return `<button class="an-pill${active}" data-an-group="${g}">${labels[g]}</button>`;
  }).join("");

  const metricCols = [
    { key: "count",      label: "#" },
    { key: "perf_pct",   label: "Ø Perf %" },
    { key: "sentiment",  label: "Ø Sent." },
    { key: "rsi",        label: "Ø RSI" },
    { key: "month_pct",  label: "Ø 1M %" },
    { key: "ma50_delta", label: "Ø MA50Δ" },
    { key: "ma200_delta",label: "Ø MA200Δ" },
  ];

  const metricsHead = metricCols.map(c => `<th class="an-th">${c.label}</th>`).join("");
  const metricsBody = grouped.map(([label, gRows]) => {
    const m = _clusterMetrics(gRows);
    const cells = metricCols.map(c => {
      const v = m[c.key];
      if (c.key === "count") return `<td class="an-td">${v}</td>`;
      return _heatCell(v);
    }).join("");
    return `<tr><td class="an-td an-td--label">${escapeHtml(label)}</td>${cells}</tr>`;
  }).join("");

  const heatmapSection = grouped.length ? `
    <div class="an-section">
      <div class="an-section__title">Heatmap – ${groupLabels[_analyseGroupBy]}</div>
      <div class="an-tbl-wrap">
        <table class="an-tbl">
          <thead><tr><th class="an-th">${groupLabels[_analyseGroupBy]}</th>${metricsHead}</tr></thead>
          <tbody>${metricsBody}</tbody>
        </table>
      </div>
    </div>` : "";

  const treemapSections = grouped.map(([label, gRows]) => _analyseGroupSection(label, gRows)).join("");

  host.innerHTML = `<div class="an">
    <div class="an-bar">
      <div class="an-pills">${filterPills}</div>
      <select class="an-select" id="an-asset-select">${assetOpts}</select>
    </div>
    <div class="an-bar">
      <span class="an-bar__label">Gruppieren:</span>
      <div class="an-pills">${groupTabs}</div>
      <span class="an-bar__info">${rows.length} Ticker</span>
    </div>

    ${heatmapSection}

    <div class="an-section">
      <div class="an-section__title">Cluster – ${groupLabels[_analyseGroupBy]}</div>
      <div class="an-groups">${treemapSections || '<div class="an-empty">Keine Daten für diese Filter</div>'}</div>
    </div>
  </div>`;

  host.querySelectorAll("[data-an-filter]").forEach(btn => {
    btn.addEventListener("click", () => { _analyseFilter = btn.dataset.anFilter; renderAnalyse(); });
  });
  host.querySelectorAll("[data-an-group]").forEach(btn => {
    btn.addEventListener("click", () => { _analyseGroupBy = btn.dataset.anGroup; renderAnalyse(); });
  });
  const assetSel = host.querySelector("#an-asset-select");
  if (assetSel) assetSel.addEventListener("change", () => { _analyseAsset = assetSel.value; renderAnalyse(); });

  if (window.lucide) lucide.createIcons();
}

/* ════════════════════════════════════════════════════
   AUTO-REFRESH (F1)
   ════════════════════════════════════════════════════ */

function isMarketHours() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin", weekday: "short",
    hour: "numeric", hour12: false, hourCycle: "h23"
  }).formatToParts(now);
  const weekday = parts.find(p => p.type === "weekday")?.value;
  const hour    = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
  return weekday !== "Sat" && weekday !== "Sun" && hour >= 8 && hour < 23;
}

const US_MICS = new Set(["XNYS", "XNAS", "XNGS", "XNCM", "XNMS", "ARCX", "BATS"]);
function isUSTicker(t) {
  const mic  = (t.stamm.twelvedata_mic_code || "").toUpperCase();
  const exch = (t.stamm.twelvedata_exchange || t.stamm.exchange || "").toUpperCase();
  if (US_MICS.has(mic)) return true;
  if (exch.includes("NASDAQ") || exch.includes("NYSE") || exch.includes("ARCA")) return true;
  return false;
}

const Progress = {
  _active: false,
  _activeText: "",
  _badge:  () => $("#auto-refresh-indicator"),
  _status: () => $("#td-status"),
  set(text, title) {
    this._active = true;
    this._activeText = text || "";
    const b = this._badge();
    if (b) {
      b.textContent = text || "";
      b.title = title || "";
      if (text) b.classList.add("auto-refresh-badge--active");
      else      b.classList.remove("auto-refresh-badge--active");
    }
    this._renderStatus();
  },
  clear() {
    this._active = false;
    this._activeText = "";
    this.renderIdle();
  },
  renderIdle() {
    if (this._active) { this._renderStatus(); return; }
    const b = this._badge();
    if (b) {
      const dayUsed = TdRL._dayUsed, dayMax = TdRL.DAY_MAX;
      const nextMs  = TdRL.nextAvailableIn();
      if (dayUsed >= dayMax)   { b.textContent = `TD ✕ ${dayUsed}/${dayMax}`; b.classList.add("auto-refresh-badge--active"); }
      else if (nextMs > 0)     { b.textContent = `⏱${Math.ceil(nextMs/1000)}s`; b.classList.add("auto-refresh-badge--active"); }
      else if (dayUsed > 0)    { b.textContent = `${dayUsed}/${dayMax}`; b.classList.add("auto-refresh-badge--active"); }
      else                     { b.textContent = ""; b.classList.remove("auto-refresh-badge--active"); }
      b.title = "";
    }
    this._renderStatus();
  },
  _renderStatus() {
    const el = this._status(); if (!el) return;
    const dayUsed = TdRL._dayUsed, dayMax = TdRL.DAY_MAX;
    const minUsed = TdRL._used,    minMax = TdRL.MAX;
    const nextMs  = TdRL.nextAvailableIn();
    el.classList.remove("td-status--active","td-status--warn","td-status--block");
    let stateLabel, stateCls = "";
    if (this._active && this._activeText) {
      stateLabel = this._activeText;
      stateCls = "td-status--active";
    } else if (dayUsed >= dayMax) {
      stateLabel = "Tageslimit erreicht — Reset 00:00 UTC";
      stateCls = "td-status--block";
    } else if (nextMs > 0) {
      stateLabel = `nächster Slot in ${Math.ceil(nextMs/1000)}s`;
      stateCls = "td-status--warn";
    } else {
      stateLabel = "bereit";
    }
    if (stateCls) el.classList.add(stateCls);
    el.innerHTML =
      `<span class="td-status__item"><span class="td-status__label">Status:</span><span class="td-status__value">${stateLabel}</span></span>` +
      `<span class="td-status__item"><span class="td-status__label">TD Tag:</span><span class="td-status__value">${dayUsed}/${dayMax}</span></span>` +
      `<span class="td-status__item"><span class="td-status__label">Minute:</span><span class="td-status__value">${minUsed}/${minMax}</span></span>`;
  }
};

function sleepWithCountdown(ms, prefix) {
  return new Promise(resolve => {
    const end = Date.now() + ms;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      Progress.set(`${prefix} ⏱${remaining}s`, `Rate-Limit Pause: ${remaining}s`);
      if (Date.now() >= end) { resolve(); return; }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

/* Flash a glow on all DOM elements (card + table row) for the given ticker IDs. */
function flashUpdated(ids) {
  if (!ids.length) return;
  const idSet = new Set(ids);
  document.querySelectorAll("[data-id]").forEach(el => {
    if (!idSet.has(el.dataset.id)) return;
    el.classList.remove("quote-updated");
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add("quote-updated");
  });
}

/* Yahoo-Stream: batched 10-parallel, 300ms pause between batches.
   Renders + flashes per ticker. Returns { ok, failed }. */
const YAHOO_BATCH = 10;
const YAHOO_PAUSE_MS = 300;

async function yahooStreamRefresh(tickers, withHistory, label = "Yahoo") {
  if (!tickers.length) return { ok: 0, failed: [] };
  let ok = 0; const failed = [];
  const total = tickers.length;
  let done = 0;

  for (let i = 0; i < tickers.length; i += YAHOO_BATCH) {
    const chunk = tickers.slice(i, i + YAHOO_BATCH);
    Progress.set(`${label} ${Math.min(i + YAHOO_BATCH, total)}/${total}`, `${label}: Batch läuft`);

    await Promise.allSettled(chunk.map(async t => {
      const sym = t.stamm.twelvedata_symbol || t.stamm.symbol;
      const y = await API.yahooQuote(t, withHistory);
      done++;
      if (!y || y._error) {
        failed.push({ symbol: sym, error: (y && y._error) || "Kein Yahoo-Ergebnis" });
        return;
      }
      t.quotes._prev = { price: t.quotes.price, macd_histogram: t.quotes.macd_histogram, ma200: t.quotes.ma200 };
      Object.assign(t.quotes, y.quote || {});
      if (withHistory && Array.isArray(y.closes) && y.closes.length) {
        const indicators = Calc.indicatorsFromCloses(y.closes, t.quotes.price);
        Object.assign(t.quotes, indicators);
        t.quotes.last7d = y.closes.slice(-7);
      }
      t.quotes._source = "yahoo";
      ok++;
      Calc.recompute(t);
      Render.all();
      flashUpdated([t.id]);
    }));
    Store.save();
    if (i + YAHOO_BATCH < tickers.length) {
      await new Promise(r => setTimeout(r, YAHOO_PAUSE_MS));
    }
  }
  return { ok, failed };
}

/* TwelveData free-tier rate limiter: 7 credits/min (1 credit reserve), 1 credit = 1 symbol.
   Called automatically by tdQuoteBatch + tdTimeSeriesBatch — protects all call paths. */
const TdRL = {
  MAX: 7, WIN: 60_000, DAY_MAX: 800,
  _used: 0, _winStart: 0,
  _dayUsed: 0, _dayKey: "",
  STORAGE_KEY: "td_rl_v1",

  _todayKey() { return new Date().toISOString().slice(0, 10); },
  _rollDay() {
    const today = this._todayKey();
    if (today !== this._dayKey) { this._dayKey = today; this._dayUsed = 0; }
  },
  loadFromStorage() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "{}");
      const today = this._todayKey();
      this._dayKey  = today;
      this._dayUsed = saved.day === today ? (+saved.used || 0) : 0;
    } catch { this._dayKey = this._todayKey(); this._dayUsed = 0; }
  },
  _persist() {
    try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify({ day: this._dayKey, used: this._dayUsed })); } catch {}
  },
  nextAvailableIn() {
    const now = Date.now();
    if (now - this._winStart >= this.WIN) return 0;
    if (this._used < this.MAX) return 0;
    return this.WIN - (now - this._winStart);
  },
  async throttle(n, hint) {
    this._rollDay();
    const now = Date.now();
    if (now - this._winStart >= this.WIN) { this._used = 0; this._winStart = now; }
    if (this._used + n > this.MAX) {
      const wait = this.WIN - (now - this._winStart) + 300;
      await sleepWithCountdown(wait, hint || "TD");
      this._used = 0; this._winStart = Date.now();
    }
    this._used += n;
    this._dayUsed += n;
    this._persist();
  }
};

/* TD-Stream: chunks tickers into batches of TdRL.MAX (7) so each batch renders
   independently — gives immediate feedback even when minute-window hits.
   The TdRL throttle inside tdQuoteBatch/tdTimeSeriesBatch still protects the credit budget. */
async function tdStreamRefresh(tickers, mode, label = "TD") {
  if (!tickers.length) return { ok: 0, failed: [] };
  const refreshFn = mode === "full" ? API.refreshFullMany : API.refreshMany;
  let ok = 0; const failed = [];
  const total = tickers.length;

  for (let i = 0; i < tickers.length; i += TdRL.MAX) {
    const chunk = tickers.slice(i, i + TdRL.MAX);
    Progress.set(`${label} ${Math.min(i + TdRL.MAX, total)}/${total}`, `${label}: Batch läuft`);
    const res = await refreshFn(chunk);
    ok += res.ok || 0;
    if (res.failed?.length) failed.push(...res.failed);
    Calc.recomputeAll();
    Store.save();
    Render.all();
    if (res.updatedIds?.length) flashUpdated(res.updatedIds);
  }
  return { ok, failed };
}

/* Split a ticker list into yahoo / td routes based on exchange classification. */
function splitByRoute(tickers) {
  return {
    yahoo: tickers.filter(t => !isUSTicker(t)),
    td:    tickers.filter(t =>  isUSTicker(t))
  };
}

/* Build yahoo + td ticker lists based on scope.
   - onload:   Yahoo = Portfolio non-US + Watchlist non-US + Neutral ALL.
               TD    = Portfolio US + Watchlist US (Neutral NIE TD).
   - active:   Yahoo = active bucket non-US (or ALL if bucket=neutral).
               TD    = active bucket US (empty if bucket=neutral).
   - selected: split the given ticker list by route.  */
function buildRefreshScope(scope, opts = {}) {
  const all = Store.state.tickers;
  if (scope === "selected") {
    return splitByRoute(opts.tickers || []);
  }
  if (scope === "active") {
    const b = Store.state.ui.bucket;
    const list = all.filter(t => t.user.bucket === b);
    if (b === "neutral") return { yahoo: list, td: [] };
    return splitByRoute(list);
  }
  /* onload */
  const portfolio = all.filter(t => t.user.bucket === "portfolio");
  const watchlist = all.filter(t => t.user.bucket === "watchlist");
  const neutral   = all.filter(t => t.user.bucket === "neutral");
  return {
    yahoo: [...portfolio.filter(t => !isUSTicker(t)),
            ...watchlist.filter(t => !isUSTicker(t)),
            ...neutral],
    td:    [...portfolio.filter(t => isUSTicker(t)),
            ...watchlist.filter(t => isUSTicker(t))]
  };
}

/* Unified refresh entry point. Yahoo + TD streams run in parallel.
   opts:
     scope:     "onload" | "active" | "selected"
     tdMode:    "flat" | "full"             (default "flat")
     yahooMode: "flat" | "full"             (default "full")
     tickers:   array (required if scope=selected)
     clearSel:  bool — clear UI selection after completion */
async function smartRefresh(opts = {}) {
  const { scope = "onload", tdMode = "flat", yahooMode = "full", tickers = null, clearSel = false } = opts;
  setRefreshLoading(true);
  const { yahoo, td } = buildRefreshScope(scope, { tickers });
  const summary = { yahoo: { ok: 0, failed: 0 }, td: { ok: 0, failed: 0 } };
  try {
    const [yRes, tRes] = await Promise.all([
      yahooStreamRefresh(yahoo, yahooMode === "full", "Yahoo"),
      tdStreamRefresh(td, tdMode, "TD")
    ]);
    summary.yahoo.ok = yRes.ok || 0;
    summary.yahoo.failed = (yRes.failed || []).length;
    summary.td.ok = tRes.ok || 0;
    summary.td.failed = (tRes.failed || []).length;

    const totalOk = summary.yahoo.ok + summary.td.ok;
    const totalFail = summary.yahoo.failed + summary.td.failed;
    if (totalOk && !totalFail)      toast(`${totalOk} aktualisiert`, "pos");
    else if (totalOk && totalFail)  toast(`${totalOk} ok, ${totalFail} Fehler`, "neg");
    else if (totalFail)             toast(`Refresh fehlgeschlagen (${totalFail})`, "neg");
  } catch (err) {
    toast("Refresh-Fehler: " + err.message, "neg");
    console.warn("[smartRefresh] fatal", err);
  } finally {
    Progress.clear();
    setRefreshLoading(false);
    if (clearSel) { Store.patchUi({ selected: [] }); }
    Render.bulkbar();
  }
}

/* ════════════════════════════════════════════════════
   SECTION 9 — INIT
   ════════════════════════════════════════════════════ */
function init() {
  console.log("[init] Merkliste boot");
  // restore dark mode
  if (localStorage.getItem("theme") === "dark") {
    document.documentElement.dataset.theme = "dark";
  }
  Store.load();
  Calc.recomputeAll();
  bindEvents();
  Render.all();
  if (window.lucide) lucide.createIcons();
  _updateDarkIcon();
  TdRL.loadFromStorage();
  setInterval(() => Progress.renderIdle(), 1000);
  Progress.renderIdle();
  console.log("[init] ready", Store.state);
  /* Hybrid sync: load from cloud silently in background, merge if newer */
  loadBlob({ silent: true });
  /* Auto-Refresh on load deaktiviert — manuell via ⟳ Buttons */
}
// ES modules are deferred — DOM is already parsed when this runs
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
