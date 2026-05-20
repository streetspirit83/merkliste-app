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
  price: null, currency_returned: null, day_change_pct: null,
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
    /* single ticker → cleaner single-call path with mic_code */
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
    /* >1 → comma-separated symbol list */
    const symbolStrings = tickers.map(t => {
      const sym  = t.stamm.twelvedata_symbol || t.stamm.symbol;
      const exch = t.stamm.twelvedata_exchange || t.stamm.exchange;
      return exch ? `${sym}:${exch}` : sym;
    });
    const url = new URL(`${CONFIG.api.twelveData.baseUrl}/quote`);
    url.searchParams.set("symbol", symbolStrings.join(","));
    url.searchParams.set("apikey", key);
    const res = await fetch(url.toString());
    const json = await res.json();

    /* top-level fatal error (no per-symbol wrapper) */
    if (json.status === "error" && !json.symbol && Object.keys(json).every(k => k === "status" || k === "code" || k === "message")) {
      throw new Error(json.message || "TD batch error");
    }

    /* TD returns { "NVDA": {...}, "SAP:XETRA": {...}, ... }; build flexible lookup */
    const out = {};
    /* if response has top-level `symbol` field, it's actually a single quote */
    if (json.symbol && json.close != null) {
      out[json.symbol] = API._tdMapQuote(json);
      /* also map under the SYMBOL:EXCH key in case our caller looks that way */
      out[symbolStrings[0]] = out[json.symbol];
      return out;
    }
    /* iterate response keys; tolerate per-symbol error objects */
    for (const [k, v] of Object.entries(json)) {
      if (!v || typeof v !== "object") continue;
      const key1 = k;                  // "SAP:XETRA"
      const key2 = k.split(":")[0];    // "SAP"
      if (v.status === "error" || v.code) {
        const errMsg = v.message || "TD error";
        out[key1] = { _error: errMsg };
        out[key2] = out[key1];
      } else if (v.close != null || v.price != null) {
        out[key1] = API._tdMapQuote(v);
        out[key2] = out[key1];
      }
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
    if (!tickers.length) return { ok: 0, failed: [] };
    const map = await API.tdQuoteBatch(tickers);
    let ok = 0; const failed = [];
    for (const t of tickers) {
      const sym  = t.stamm.twelvedata_symbol || t.stamm.symbol;
      const exch = t.stamm.twelvedata_exchange || t.stamm.exchange;
      const entry = map[sym] || (exch && map[`${sym}:${exch}`]);
      if (!entry)            { failed.push({ symbol: sym, error: "Kein Ergebnis", ticker: t }); continue; }
      if (entry._error)      { failed.push({ symbol: sym, error: entry._error,    ticker: t }); continue; }
      t.quotes._prev = { price: t.quotes.price, macd_histogram: t.quotes.macd_histogram, ma200: t.quotes.ma200 };
      Object.assign(t.quotes, entry);
      ok++;
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
      return { ok: ok + recovered.size, failed: remaining.map(f => ({ symbol: f.symbol, error: f.error })) };
    }
    return { ok, failed: [] };
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
    const url = new URL(`${CONFIG.api.twelveData.baseUrl}/time_series`);
    url.searchParams.set("symbol", symbolStrings.join(","));
    url.searchParams.set("interval", "1day");
    url.searchParams.set("outputsize", String(outputsize));
    url.searchParams.set("order", "ASC");
    url.searchParams.set("apikey", key);
    const res = await fetch(url.toString());
    const json = await res.json();

    /* fatal top-level error */
    if (json.status === "error" && !json.values && !json.meta &&
        Object.keys(json).every(k => k === "status" || k === "code" || k === "message")) {
      throw new Error(json.message || "TD time_series batch error");
    }

    const out = {};
    /* single-symbol fallback: TD returns flat { meta:{symbol,...}, values:[...] } */
    if (json.values && json.meta) {
      const sym = json.meta.symbol;
      out[sym] = json.values.map(v => +v.close).filter(n => !isNaN(n));
      out[symbolStrings[0]] = out[sym];
      return out;
    }
    /* multi-symbol: { "NVDA": {meta, values, status}, "SAP:XETRA": {...}, ... } */
    for (const [k, v] of Object.entries(json)) {
      if (!v || typeof v !== "object") continue;
      const key1 = k;
      const key2 = k.split(":")[0];
      if (v.status === "error" || v.code) {
        out[key1] = { _error: v.message || "TD error" };
        out[key2] = out[key1];
      } else if (Array.isArray(v.values)) {
        out[key1] = v.values.map(x => +x.close).filter(n => !isNaN(n));
        out[key2] = out[key1];
      }
    }
    return out;
  },

  /* Full refresh = quote + time_series → computes MAs/RSI from closes */
  async refreshFullMany(tickers) {
    if (!tickers.length) return { ok: 0, failed: [] };
    /* run both in parallel */
    const [qMap, tsMap] = await Promise.all([
      API.tdQuoteBatch(tickers),
      API.tdTimeSeriesBatch(tickers, 210)
    ]);
    let ok = 0; const failed = [];
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
        ok++;  /* quote at least worked */
      } else {
        ok++;
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
          r.ticker.quotes.last7d = [...y.closes].reverse().slice(-7);
          recoveredHist.add(r.symbol);
        }
        r.ticker.quotes._source = "yahoo";
        if (wasFullyFailed) recoveredFully.add(r.symbol);
      }
      /* drop fully-recovered from failed; bump ok by count of recovered-fully */
      const remaining = failed.filter(f => !(recoveredFully.has(f.symbol) || recoveredHist.has(f.symbol)));
      return { ok: ok + recoveredFully.size, failed: remaining.map(f => ({ symbol: f.symbol, error: f.error })) };
    }
    return { ok, failed: failed.map(f => ({ symbol: f.symbol, error: f.error })) };
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
        benchmarks[i].week_change_pct  = c.length >= 5  ? +((c[0] - c[4])  / c[4]  * 100).toFixed(2) : null;
        benchmarks[i].month_change_pct = c.length >= 21 ? +((c[0] - c[20]) / c[20] * 100).toFixed(2) : null;
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
      rsi, macd, macd_signal, macd_histogram
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

  /* evaluate one alert against current quotes → boolean trig */
  evalAlert(alert, q) {
    if (!alert) return false;
    const noTh = ALERT_NO_THRESHOLD.has(alert.type);
    if (!noTh && alert.threshold == null) return false;
    const prev = q._prev || null;
    switch (alert.type) {
      case "price_below": return q.price != null && q.price <= alert.threshold;
      case "price_above": return q.price != null && q.price >= alert.threshold;
      case "rsi_above":   return q.rsi   != null && q.rsi   >= alert.threshold;
      case "rsi_below":   return q.rsi   != null && q.rsi   <= alert.threshold;
      case "ma20_below":  return q.price != null && q.ma20  != null && q.price <= q.ma20;
      case "ma50_below":  return q.price != null && q.ma50  != null && q.price <= q.ma50;
      case "ma200_below": return q.price != null && q.ma200 != null && q.price <= q.ma200;
      case "macd_bullish":return q.macd_histogram != null && q.macd_histogram > 0;
      case "macd_bearish":return q.macd_histogram != null && q.macd_histogram < 0;
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
        return q.volume != null && q.avg_volume != null && q.avg_volume > 0 && q.volume >= alert.threshold * q.avg_volume;
      default: return false;
    }
  },

  /* recompute calculations block for ONE ticker */
  recompute(t) {
    const sent = Calc.sentiment(t.quotes);
    const pos  = Calc.position(t);
    const alerts = (t.user.alerts || []).map(a => ({ ...a, _trig: Calc.evalAlert(a, t.quotes) }));
    const alert_triggered = alerts.some(a => a._trig);
    t.calculations = {
      trends: {
        sentiment: sent.sentiment,
        sentiment_score: sent.sentiment_score,
        sentiment_breakdown: sent.sentiment_breakdown,
        trend_strength: sent.trend_strength,
        ...pos,
        alert_triggered,
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
    asset_type: s.asset_type, sector: s.sector, currency: s.currency,
    tradingview_url: s.tradingview_url || null,
    stocktwits_url: s.stocktwits_url || `https://stocktwits.com/symbol/${s.symbol}`,
    bucket: u.bucket, priority: u.priority, notes: u.notes, tags: u.tags,
    entry_price_manual: u.entry_price_manual, entry_shares: u.entry_shares,
    alerts: u.alerts || [],
    price, currency_returned: displayCcy, day_change_pct: q.day_change_pct,
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
    this.filterBtn();
    renderBenchBar();
  },
  viewMode() {
    const { view, activeView } = Store.state.ui;
    const inScreener = activeView !== "portfolio";
    const showBench  = inScreener && view === "table";
    $("#btn-element-card-view") .setAttribute("aria-pressed", view === "cards");
    $("#btn-element-table-view").setAttribute("aria-pressed", view === "table");
    $("#subbar").hidden         = !inScreener;
    $("#pfbar").hidden          = inScreener;
    $("#benchbar").hidden       = !showBench;
    $("#view-screener").hidden  = !inScreener;
    $("#view-portfolio").hidden = inScreener;
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
    const scope = n > 0 ? `${n} ausgewählte` : `Bucket "${cur}"`;
    if (rb)  rb.title  = `Quick: ${scope} — nur Kurs`;
    if (rbf) rbf.title = `Full: ${scope} — Kurs + Historie (MA/RSI)`;
  },
  filterBtn() {
    $("#btn-filter-trig").setAttribute("aria-pressed", !!Store.state.ui.triggeredOnly);
  }
};

/* ────────── formatting helpers ────────── */
const pctFmt = (v, plus = true) => (v == null || isNaN(v)) ? "—"
  : (plus && v > 0 ? "+" : "") + Number(v).toFixed(2) + "%";
const numFmt = (v, d = 2) => (v == null || isNaN(v)) ? "—"
  : Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const signCls = v => v == null ? "" : (v > 0 ? "pos" : v < 0 ? "neg" : "dim");

/* ────────── visible rows: bucket + triggered-filter ────────── */
function visibleRows() {
  const { bucket, triggeredOnly } = Store.state.ui;
  return Store.state.tickers
    .filter(t => t.user.bucket === bucket)
    .filter(t => !triggeredOnly || (t.calculations && t.calculations.trends && t.calculations.trends.alert_triggered))
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

/* ────────── table columns ────────── */
const COLS_SELECT = [
  { key:"__select", label:`<input type="checkbox" id="tbl-select-all" aria-label="Alle wählen" />`,
    cls:"col-select", noSort:true,
    cell: t => `<input type="checkbox" class="row-select" data-id="${t.id}" aria-label="Wähle ${t.symbol}" />` }
];
const COLS_BASE = [
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
  const lblMap = { price_below:"≤", price_above:"≥", rsi_above:"RSI>", rsi_below:"RSI<", ma20_below:"<MA20", ma50_below:"<MA50", ma200_below:"<MA200", macd_bullish:"MACD↑", macd_bearish:"MACD↓", reversal_up_short:"↑MACD", reversal_down_short:"↓MACD", reversal_up_long:"↑MA200", reversal_down_long:"↓MA200", vol_spike:"VOL×" };
  const out = alerts.map(a => {
    let lbl, v;
    if (a.type === "ma_below_pct" || a.type === "ma_above_pct") {
      const sign = a.type === "ma_above_pct" ? "+" : "−";
      lbl = `${a.type==="ma_above_pct"?">":"<"}${(a.ma||"ma50").toUpperCase()} ${sign}${a.threshold}%`;
      v = "";
    } else {
      lbl = lblMap[a.type] || a.type;
      v   = a.type === "rsi_above" || a.type === "rsi_below" ? a.threshold
          : a.type === "vol_spike" ? `${a.threshold}×`
          : numFmt(a.threshold);
    }
    const side = a.nk_side ? ` <span class="pill pill--${a.nk_side === "buy" ? "pos" : "neg"}" style="font-size:10px">${a.nk_side === "buy" ? "B" : "S"}${a.nk_shares != null ? " " + numFmt(a.nk_shares, 0) : ""}</span>` : "";
    return `<span class="alerts__chip ${a._trig ? "is-trig" : ""}"><b>${lbl}</b>${v}${side}</span>`;
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
  </div>`;
}

function cardDefault(t) {
  return `<article class="tcard has-select ${t.alert_triggered ? "is-trig" : ""}" data-id="${t.id}">
    ${selectChip(t)}
    <div class="tcard__hd">
      <span class="tcard__sym">${t.symbol}</span>
      ${t.name ? `<span class="tcard__name">${t.name}</span>` : ""}
      <div class="tcard__hd-right">${priceLine(t)}</div>
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

  return `<article class="tcard has-select ${t.alert_triggered ? "is-trig" : ""}" data-id="${t.id}">
    ${selectChip(t)}
    ${t.alert_triggered ? '<span class="tcard__warn" title="Alert ausgelöst">!</span>' : ""}
    <div class="tcard__hd">
      <span class="tcard__sym">${t.symbol}</span>
      ${t.name ? `<span class="tcard__name">${t.name}</span>` : ""}
      ${shares}
      <div class="tcard__hd-right">${priceLine(t)}</div>
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
  const selSet = new Set(Store.state.ui.selected);
  const visIds = rows.map(r => r.id);
  const selCount = visIds.filter(id => selSet.has(id)).length;
  const allSel = selCount === visIds.length && visIds.length > 0;
  const someSel = selCount > 0 && !allSel;
  const headHtml = `<div class="card-list__head">
    <label class="card-list__select">
      <input type="checkbox" id="cards-select-all" ${allSel ? "checked" : ""} aria-label="Alle wählen / Auswahl aufheben" />
      <span>${selCount > 0 ? `${selCount} gewählt — Auswahl aufheben` : "Alle wählen"}</span>
    </label>
  </div>`;
  host.innerHTML = headHtml + rows.map(tpl).join("");
  const selAll = $("#cards-select-all");
  if (selAll) {
    selAll.indeterminate = someSel;
    selAll.addEventListener("click", e => {
      e.stopPropagation();
      const shouldSelectAll = selCount === 0;
      let sel = Store.state.ui.selected.filter(id => !visIds.includes(id));
      if (shouldSelectAll) sel = [...sel, ...visIds];
      Store.patchUi({ selected: sel });
      renderCards();
      Render.bulkbar();
    });
  }

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
  if (typeof PROMPTS !== "undefined") updatePromptText();
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
const ALERT_NO_THRESHOLD = new Set(["ma20_below","ma50_below","ma200_below","macd_bullish","macd_bearish","reversal_up_short","reversal_down_short","reversal_up_long","reversal_down_long"]);

function renderAlertEditor(alerts, t) {
  const host = $("#edit-alerts-list");
  const MA_PCT = new Set(["ma_below_pct","ma_above_pct"]);

  host.innerHTML = alerts.map((a, i) => {
    const noTh    = ALERT_NO_THRESHOLD.has(a.type);
    const needsMa = MA_PCT.has(a.type);
    const isVol   = a.type === "vol_spike";
    const pholder = needsMa ? "% Abstand" : isVol ? "Faktor (z.B. 2)" : "Schwelle";
    const defVal  = a.threshold ?? (needsMa ? 20 : isVol ? 2 : "");
    const maVal   = a.ma || "ma50";
    return `<div class="alert-row" data-idx="${i}">
      <div class="alert-row__main">
        <select class="al-type">
          <option value="price_below"         ${a.type==="price_below"        ?"selected":""}>Preis ≤ (SL/Buy)</option>
          <option value="price_above"         ${a.type==="price_above"        ?"selected":""}>Preis ≥ (Sell/TP)</option>
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
        </select>
        <select class="al-ma" ${needsMa ? "" : "hidden"}>
          <option value="ma20"  ${maVal==="ma20" ?"selected":""}>MA20</option>
          <option value="ma50"  ${maVal==="ma50" ?"selected":""}>MA50</option>
          <option value="ma200" ${maVal==="ma200"?"selected":""}>MA200</option>
        </select>
        <input class="al-th" type="number" step="any" value="${defVal}" placeholder="${pholder}" ${noTh?"hidden":""} />
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
      const thEl = row.querySelector(".al-th");
      thEl.hidden      = noTh;
      thEl.placeholder = needsMa ? "% Abstand" : isVol ? "Faktor (z.B. 2)" : "Schwelle";
      if (needsMa && !thEl.value) thEl.value = 20;
      if (isVol   && !thEl.value) thEl.value = 2;
      row.querySelector(".al-ma").hidden = !needsMa;
    });
  });
  if (window.lucide) lucide.createIcons();
}

function collectAlertsFromEditor() {
  return $$("#edit-alerts-list .alert-row").map(row => {
    const type  = row.querySelector(".al-type").value;
    const maEl  = row.querySelector(".al-ma");
    const ma    = (maEl && !maEl.hidden) ? maEl.value : undefined;
    const extra = ma !== undefined ? { ma } : {};
    if (ALERT_NO_THRESHOLD.has(type)) return { type, threshold: null, ...extra };
    const th = row.querySelector(".al-th").value;
    if (th === "" || isNaN(+th)) return null;
    return { type, threshold: +th, ...extra };
  }).filter(Boolean);
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
    const buys  = (t.user.trades || []).filter(tr => tr.type === "buy"  && tr.price != null && tr.shares != null);
    const sells = (t.user.trades || []).filter(tr => tr.type === "sell" && tr.shares != null);
    const totalBuyShares  = buys.reduce((s, tr) => s + tr.shares, 0);
    const totalSellShares = sells.reduce((s, tr) => s + tr.shares, 0);
    if (totalBuyShares > 0) {
      t.user.entry_price_manual = +(buys.reduce((s, tr) => s + tr.price * tr.shares, 0) / totalBuyShares).toFixed(4);
      t.user.entry_shares = +(totalBuyShares - totalSellShares).toFixed(4);
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

/* ─── NACHKAUF modal ─── */
function openNachkauf(id) {
  const t = Store.byId(id); if (!t) return;
  Store.patchUi({ nachkaufId: id });
  $("#modal-nk-title").textContent = `${t.stamm.symbol} · Kalkulator`;
  const entry  = t.user.entry_price_manual;
  const shares = t.user.entry_shares;
  const price  = t.quotes.price;
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
    const liveValue = t.quotes.price != null ? newShares * t.quotes.price : null;
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
    const liveRemain    = t.quotes.price != null ? remainShares * t.quotes.price : null;
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

function normalizeImportItem(raw) {
  if (!raw || typeof raw !== "object") return null;

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
/* Generic refresh runner: takes a refreshFn returning { ok, failed } */
async function runRefresh(refreshFn, list, label) {
  if (!list.length) { toast("Nichts zu aktualisieren", "neg"); return; }
  setRefreshLoading(true);
  try {
    await API.fetchEurUsd();
    const res = await refreshFn(list);
    list.forEach(Calc.recompute);
    Store.patchUi({ selected: [] });
    Store.save();
    Render.bucket();
    Render.bulkbar();
    if (res.failed.length === 0) {
      toast(`${res.ok} ${label}`, "pos");
    } else if (res.ok === 0) {
      const firstErr = res.failed[0];
      toast(`Fehlgeschlagen: ${firstErr.symbol} — ${firstErr.error}`, "neg");
      console.warn("[refresh] all failed", res.failed);
    } else {
      toast(`${res.ok} ${label}, ${res.failed.length} fehlgeschlagen (${res.failed.slice(0,3).map(f=>f.symbol).join(", ")}${res.failed.length>3?"…":""})`, "neg");
      console.warn("[refresh] partial", res.failed);
    }
  } catch (err) {
    toast("Refresh fehlgeschlagen: " + err.message, "neg");
    console.warn("[refresh] fatal", err);
  } finally { setRefreshLoading(false); }
}
const refreshList     = (list, label) => runRefresh(API.refreshMany,     list, label);
const refreshListFull = (list, label) => runRefresh(API.refreshFullMany, list, label);
const refreshBucket = b => refreshList(Store.state.tickers.filter(t => t.user.bucket === b), `${b} aktualisiert`);
/* Smart bulk-refresh: with selection → only selected; empty selection → full current bucket */
function bulkRefresh() {
  const ui = Store.state.ui;
  if (ui.selected.length > 0) {
    refreshList(Store.state.tickers.filter(t => ui.selected.includes(t.id)), "ausgewählte aktualisiert");
  } else {
    refreshList(Store.state.tickers.filter(t => t.user.bucket === ui.bucket), `${ui.bucket} aktualisiert`);
  }
}
function bulkRefreshFull() {
  const ui = Store.state.ui;
  if (ui.selected.length > 0) {
    refreshListFull(Store.state.tickers.filter(t => ui.selected.includes(t.id)), "ausgewählte vollständig aktualisiert");
  } else {
    refreshListFull(Store.state.tickers.filter(t => t.user.bucket === ui.bucket), `${ui.bucket} vollständig aktualisiert`);
  }
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
    for (const a of trigs) {
      items.push({ t, a });
    }
  }
  // sort: triggered first
  items.sort((x, y) => (y.a._trig ? 1 : 0) - (x.a._trig ? 1 : 0));
  const lblMap = { price_below:"Preis ≤", price_above:"Preis ≥", rsi_above:"RSI ≥", rsi_below:"RSI ≤", ma20_below:"Preis ≤ MA20", ma50_below:"Preis ≤ MA50", ma200_below:"Preis ≤ MA200", macd_bullish:"MACD bullisch", macd_bearish:"MACD bärisch", reversal_up_short:"Trendwende ↑ kurzfristig", reversal_down_short:"Trendwende ↓ kurzfristig", reversal_up_long:"Trendwende ↑ langfristig", reversal_down_long:"Trendwende ↓ langfristig", vol_spike:"Volumen Spike ≥" };
  const body = $("#modal-alerts-body");
  if (!items.length) {
    body.innerHTML = `<div class="alert-overview__empty">Keine Alerts definiert</div>`;
  } else {
    body.innerHTML = `<div class="alert-overview">${items.map(({t,a}) => {
      let typeLabel, valLabel;
      if (a.type === "ma_below_pct" || a.type === "ma_above_pct") {
        const maName = (a.ma || "ma50").toUpperCase();
        const sign   = a.type === "ma_above_pct" ? "+" : "−";
        typeLabel = `Preis ${a.type==="ma_above_pct"?"≥":"≤"} ${maName} ${sign}${a.threshold}%`;
        const maVal = a.ma ? t.quotes[a.ma] : null;
        const absPrice = maVal != null && a.threshold != null
          ? +(maVal * (a.type==="ma_above_pct" ? (1 + a.threshold/100) : (1 - a.threshold/100))).toFixed(2)
          : null;
        valLabel = absPrice != null ? numFmt(absPrice) : "—";
      } else if (a.type === "vol_spike") {
        typeLabel = lblMap[a.type] || a.type;
        valLabel  = a.threshold != null ? `${a.threshold}×Ø` : "—";
      } else {
        typeLabel = lblMap[a.type] || a.type;
        valLabel  = numFmt(a.threshold);
      }
      return `
      <div class="alert-overview__item ${a._trig ? "is-trig" : ""}">
        <span class="alert-overview__sym">${t.stamm.symbol}</span>
        <span class="alert-overview__type">${typeLabel}</span>
        <span class="alert-overview__val">${valLabel} ${a._trig ? "· ⚠ ausgelöst" : ""}</span>
      </div>`;
    }).join("")}</div>`;
  }
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
  $("#btn-json-export").addEventListener("click", exportJson);
  $("#menu-nav")       .addEventListener("click", () => { Store.patchUi({ menuOpen: !Store.state.ui.menuOpen }); Render.menu(); });

  // sub bar
  $("#btn-element-card-view") .addEventListener("click", () => { Store.patchUi({ view: "cards" }); Render.viewMode(); });
  $("#btn-element-table-view").addEventListener("click", () => { Store.patchUi({ view: "table" }); Render.viewMode(); });
  $("#btn-element-refresh")     .addEventListener("click", () => refreshBucket(Store.state.ui.bucket));
  $("#btn-element-fullrefresh") .addEventListener("click", () => refreshListFull(Store.state.tickers.filter(t => t.user.bucket === Store.state.ui.bucket), `${Store.state.ui.bucket} vollständig aktualisiert`));
  $("#btn-filter-trig")         .addEventListener("click", () => {
    Store.patchUi({ triggeredOnly: !Store.state.ui.triggeredOnly });
    Render.filterBtn(); Render.bucket();
  });

  // bulkbar
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
  $("#menu-nav-btn-screener") .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); switchView("screener"); });
  $("#menu-nav-btn-portfolio").addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); switchView("portfolio"); });
  document.addEventListener("click", e => {
    const tab = e.target.closest(".pf-tab");
    if (tab) switchPfTab(tab.dataset.pftab);
  });
  $("#menu-nav-btn-config")   .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); openConfig(); });
  $("#menu-nav-btn-cloud-load").addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); loadBlob({ silent: false }); });
  $("#menu-nav-btn-cloud-save").addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); saveBlob(null); });
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
  if (promptSel && typeof PROMPTS !== "undefined") {
    PROMPTS.forEach(p => {
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
  }
}

function updatePromptText() {
  if (!_currentInfoTicker || typeof PROMPTS === "undefined") return;
  const sel = $("#info-prompt-select");
  const prompt = PROMPTS.find(p => p.id === sel.value);
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

  const totalValue = positions.reduce((s, t) => s + (t.position_value  || 0), 0);
  const totalCost  = positions.reduce((s, t) => s + ((t.entry_price_manual || 0) * (t.entry_shares || 0)), 0);
  const totalPlAbs = positions.reduce((s, t) => s + (t.position_pl_abs || 0), 0);
  const totalPlPct = totalCost > 0 ? (totalPlAbs / totalCost) * 100 : null;

  const W = 340, H = 160;
  const treemap = positions.length ? buildTreemap(positions, W, H) : [];

  host.innerHTML = `
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
    ${treemap.length ? `<div class="pf-treemap-wrap">
      <svg class="pf-treemap" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
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
      </svg>
    </div>` : ""}
    ${positions.length ? pfWaterfall(positions) : ""}
    ${positions.length ? pfScatterMatrix(positions) : ""}
    ${pfStrategySplit(allPortfolio)}`;

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
   SECTION 8 — INIT
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
  console.log("[init] ready", Store.state);
  /* Hybrid sync: load from cloud silently in background, merge if newer */
  loadBlob({ silent: true });
}
document.addEventListener("DOMContentLoaded", init);
