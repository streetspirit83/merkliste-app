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
  volume: null, avg_volume: null, pos_52whigh: null, pos_52low: null,
  rsi: null, macd: null, macd_signal: null, macd_histogram: null,
  ma20: null, ma20_delta_pct: null,
  ma50: null, ma50_delta_pct: null,
  ma200: null, ma200_delta_pct: null,
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

const Schema = {
  tickers: [],
  ui: {
    view:        CONFIG.defaults.view,
    bucket:      CONFIG.defaults.bucket,
    menuOpen:    false,
    sortKey:     "day_change_pct",
    sortDir:     "desc",
    triggeredOnly: false,
    selected:    [],          // array of ticker ids
    editingId:   null,
    nachkaufId:  null
  },
  config: { twelveDataKey: CONFIG.api.twelveData.key }
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
      if (qEntry && !qEntry._error) Object.assign(t.quotes, qEntry);
      if (tsEntry && !tsEntry._error && Array.isArray(tsEntry) && tsEntry.length) {
        const indicators = Calc.indicatorsFromCloses(tsEntry, t.quotes.price);
        Object.assign(t.quotes, indicators);
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
      ts: Date.now(),
      _source: "yahoo",
      _api_meta: {
        symbol_returned: q.symbol, exchange_returned: q.fullExchangeName,
        provider: "yahoo"
      }
    };
    const closes = Array.isArray(j.closes) ? j.closes.filter(n => n != null && !isNaN(+n)).map(n => +n) : null;
    return { quote, closes };
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
    const price = t.quotes.price;
    const entry = t.user.entry_price_manual;
    const sh    = t.user.entry_shares;
    if (price == null || entry == null) return { performance_pct: null, performance_abs: null, position_value: null, position_pl_abs: null };
    const performance_abs = +(price - entry).toFixed(2);
    const performance_pct = +((performance_abs / entry) * 100).toFixed(2);
    const position_value  = sh != null ? +(price * sh).toFixed(2) : null;
    const position_pl_abs = sh != null ? +(performance_abs * sh).toFixed(2) : null;
    return { performance_pct, performance_abs, position_value, position_pl_abs };
  },

  /* evaluate one alert against current quotes → boolean trig */
  evalAlert(alert, q) {
    if (!alert || alert.threshold == null) return false;
    switch (alert.type) {
      case "price_below": return q.price != null && q.price <= alert.threshold;
      case "price_above": return q.price != null && q.price >= alert.threshold;
      case "rsi_above":   return q.rsi   != null && q.rsi   >= alert.threshold;
      case "rsi_below":   return q.rsi   != null && q.rsi   <= alert.threshold;
      case "ma20_below":  return q.price != null && q.ma20 != null && q.price <= q.ma20;
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
  return {
    id: t.id, _raw: t,
    symbol: s.symbol, name: s.name, exchange: s.exchange,
    asset_type: s.asset_type, sector: s.sector, currency: s.currency,
    bucket: u.bucket, priority: u.priority, notes: u.notes, tags: u.tags,
    entry_price_manual: u.entry_price_manual, entry_shares: u.entry_shares,
    alerts: u.alerts || [],
    price: q.price, currency_returned: q.currency_returned, day_change_pct: q.day_change_pct,
    volume: q.volume, avg_volume: q.avg_volume,
    pos_52whigh: q.pos_52whigh, pos_52low: q.pos_52low,
    rsi: q.rsi, macd: q.macd, macd_signal: q.macd_signal, macd_histogram: q.macd_histogram,
    ma20: q.ma20, ma20_delta_pct: q.ma20_delta_pct,
    ma50: q.ma50, ma50_delta_pct: q.ma50_delta_pct,
    ma200: q.ma200, ma200_delta_pct: q.ma200_delta_pct,
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
  },
  viewMode() {
    const { view } = Store.state.ui;
    $("#btn-element-card-view") .setAttribute("aria-pressed", view === "cards");
    $("#btn-element-table-view").setAttribute("aria-pressed", view === "table");
    $("#screener-card-view") .hidden = view !== "cards";
    $("#screener-table-view").hidden = view !== "table";
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

/* ────────── table columns ────────── */
const COLS_SELECT = [
  { key:"__select", label:`<input type="checkbox" id="tbl-select-all" aria-label="Alle wählen" />`,
    cls:"col-select", noSort:true,
    cell: t => `<input type="checkbox" class="row-select" data-id="${t.id}" aria-label="Wähle ${t.symbol}" />` }
];
const COLS_BASE = [
  { key:"symbol", label:"Symbol", cls:"col-sym",
    cell: t => `<span class="sym-strong">${t.symbol}</span><span class="sym-sub">${t.exchange||""}</span>` },
  { key:"price",          label:"Preis",   cell: t => numFmt(t.price) },
  { key:"day_change_pct", label:"Day %",   cell: t => `<span class="${signCls(t.day_change_pct)}">${pctFmt(t.day_change_pct)}</span>` }
];
const COLS_PORTFOLIO_EXTRA = [
  { key:"performance_pct", label:"Perf %",   cell: t => `<span class="${signCls(t.performance_pct)}">${pctFmt(t.performance_pct)}</span>` },
  { key:"position_value",  label:"Wert",     cell: t => numFmt(t.position_value) },
  { key:"position_pl_abs", label:"P/L",      cell: t => `<span class="${signCls(t.position_pl_abs)}">${numFmt(t.position_pl_abs)}</span>` }
];
const COLS_TAIL = [
  { key:"ma20_delta_pct",  label:"MA20 Δ",  cell: t => `<span class="${signCls(t.ma20_delta_pct)}">${pctFmt(t.ma20_delta_pct)}</span>` },
  { key:"ma50_delta_pct",  label:"MA50 Δ",  cell: t => `<span class="${signCls(t.ma50_delta_pct)}">${pctFmt(t.ma50_delta_pct)}</span>` },
  { key:"ma200_delta_pct", label:"MA200 Δ", cell: t => `<span class="${signCls(t.ma200_delta_pct)}">${pctFmt(t.ma200_delta_pct)}</span>` },
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
      renderTable();
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
  const lblMap = { price_below:"SL", price_above:"BY", rsi_above:"RSI>", rsi_below:"RSI<", ma20_below:"<MA20" };
  const out = alerts.map(a => {
    const lbl = lblMap[a.type] || a.type;
    const v   = a.type === "rsi_above" || a.type === "rsi_below" ? a.threshold : numFmt(a.threshold);
    return `<span class="alerts__chip ${a._trig ? "is-trig" : ""}"><b>${lbl}</b>${v}</span>`;
  });
  return inline
    ? `<span class="alerts" style="display:inline-flex"><span class="tcard__label">Alerts</span>${out.join("")}</span>`
    : `<div class="alerts"><span class="tcard__label">Alerts</span>${out.join("")}</div>`;
}

function actionsRow(t) {
  const isPort = t.bucket === "portfolio";
  return `<div class="tcard__actions">
    <button class="tcard__act btn-info" data-id="${t.id}" aria-label="Details" title="Details"><i data-lucide="info" class="icon icon-sm"></i></button>
    <button class="tcard__act btn-edit" data-id="${t.id}" aria-label="Bearbeiten" title="Bearbeiten"><i data-lucide="pencil" class="icon icon-sm"></i></button>
    ${isPort ? `<button class="tcard__act btn-nk" data-id="${t.id}" aria-label="Nachkauf" title="Nachkauf-Kalkulator"><i data-lucide="calculator" class="icon icon-sm"></i></button>` : ""}
    <button class="tcard__act btn-refresh-one" data-id="${t.id}" aria-label="Refresh diesen Eintrag" title="Refresh"><i data-lucide="refresh-cw" class="icon icon-sm"></i></button>
  </div>`;
}

function priceLine(t) {
  const ccy = t.currency_returned || t.currency || "USD";
  return `<span class="tcard__chip">${numFmt(t.price)} <span class="dim">${ccy}</span> <span class="${signCls(t.day_change_pct)}">(${pctFmt(t.day_change_pct)})</span></span>`;
}
function maChip(label, v) { return `<span><span class="tcard__label">${label}</span><span class="${signCls(v)}">${pctFmt(v)}</span></span>`; }
function trendChip(t) { return `<span class="trend"><span class="tcard__label">Trend</span>${trendBar(t.sentiment_score)}<span class="trend__val ${signCls(t.sentiment_score)}">${numFmt(t.sentiment_score, 2)}</span></span>`; }
function rsiChip(t) { const r = rsiClass(t.rsi); return `<span><span class="tcard__label">RSI</span><span class="rsi__dot ${r.cls}"></span>${numFmt(t.rsi, 0)} <span class="dim">(${r.label})</span></span>`; }
function sentChip(t) { return `<span><span class="tcard__label">Sent</span><span class="${signCls(t.sentiment_score)}">${numFmt(t.sentiment_score, 2)}</span></span>`; }
function plChip(t) {
  if (t.performance_pct == null) return `<span><span class="tcard__label">P/L</span><span class="dim">—</span></span>`;
  return `<span><span class="tcard__label">P/L</span><span class="${signCls(t.performance_pct)}">${pctFmt(t.performance_pct)}</span> <span class="${signCls(t.position_pl_abs)}">(${(t.position_pl_abs||0) >= 0 ? "+" : ""}${numFmt(t.position_pl_abs || 0, 0)})</span></span>`;
}

function selectChip(t) {
  const checked = Store.state.ui.selected.includes(t.id);
  return `<input type="checkbox" class="tcard__select card-select" data-id="${t.id}" aria-label="Wähle ${t.symbol}" ${checked ? "checked" : ""} />`;
}

function cardNeutral(t) {
  return `<article class="tcard has-select ${t.alert_triggered ? "is-trig" : ""}" data-id="${t.id}">
    ${selectChip(t)}
    <div class="tcard__row">
      <span class="tcard__sym">${t.symbol}</span>${t.name ? ` <span class="tcard__name">${t.name}</span>` : ""}
      <span class="tcard__sep">|</span>${priceLine(t)}
      <span class="tcard__sep">|</span>${maChip("MA20", t.ma20_delta_pct)}
      <span class="tcard__sep">|</span>${maChip("MA200", t.ma200_delta_pct)}
    </div>
    <div class="tcard__row">
      ${trendChip(t)}<span class="tcard__sep">|</span>${rsiChip(t)}<span class="tcard__sep">|</span>${sentChip(t)}
    </div>
    ${actionsRow(t)}
  </article>`;
}
function cardWatchlist(t) {
  return `<article class="tcard has-select ${t.alert_triggered ? "is-trig" : ""}" data-id="${t.id}">
    ${selectChip(t)}
    <span class="tcard__flag" title="Watchlist"><i data-lucide="flag" class="icon icon-sm"></i></span>
    <div class="tcard__row">
      <span class="tcard__sym">${t.symbol}</span>${t.name ? ` <span class="tcard__name">${t.name}</span>` : ""}
      <span class="tcard__sep">|</span>${priceLine(t)}
      <span class="tcard__sep">|</span>${maChip("MA20", t.ma20_delta_pct)}
      <span class="tcard__sep">|</span>${maChip("MA200", t.ma200_delta_pct)}
    </div>
    <div class="tcard__row">
      ${trendChip(t)}<span class="tcard__sep">|</span>${rsiChip(t)}<span class="tcard__sep">|</span>${sentChip(t)}
    </div>
    ${alertChips(t)}
    ${actionsRow(t)}
  </article>`;
}
function cardPortfolio(t) {
  return `<article class="tcard has-select ${t.alert_triggered ? "is-trig" : ""}" data-id="${t.id}">
    ${selectChip(t)}
    <span class="tcard__flag">${t.alert_triggered ? '<span class="tcard__warn" title="Alert ausgelöst">!</span>' : ""}<i data-lucide="briefcase" class="icon icon-sm"></i></span>
    <div class="tcard__row">
      <span class="tcard__sym">${t.symbol}</span>${t.name ? ` <span class="tcard__name">${t.name}</span>` : ""}
      <span class="tcard__sep">|</span>${plChip(t)}
      <span class="tcard__sep">|</span><span><span class="tcard__label">Preis</span>${numFmt(t.price)} <span class="${signCls(t.day_change_pct)}">(${pctFmt(t.day_change_pct)})</span></span>
    </div>
    <div class="tcard__row">
      ${trendChip(t)}<span class="tcard__sep">|</span>${rsiChip(t)}<span class="tcard__sep">|</span>${sentChip(t)}
    </div>
    <div class="tcard__row">
      ${maChip("MA20", t.ma20_delta_pct)}<span class="tcard__sep">|</span>${maChip("MA200", t.ma200_delta_pct)}
      ${t.alerts && t.alerts.length ? '<span class="tcard__sep">|</span>' + alertChips(t, true) : ""}
    </div>
    ${actionsRow(t)}
  </article>`;
}

function renderCards() {
  const host = $("#screener-card-view");
  if (!host) return;
  const { bucket } = Store.state.ui;
  const rows = visibleRows();
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
  const tpl = bucket === "watchlist" ? cardWatchlist : bucket === "portfolio" ? cardPortfolio : cardNeutral;
  host.innerHTML = rows.map(tpl).join("");

  host.querySelectorAll(".btn-info").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); openInfo(e.currentTarget.dataset.id); }));
  host.querySelectorAll(".btn-edit").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); openEdit(e.currentTarget.dataset.id); }));
  host.querySelectorAll(".btn-nk")  .forEach(b => b.addEventListener("click", e => { e.stopPropagation(); openNachkauf(e.currentTarget.dataset.id); }));
  host.querySelectorAll(".btn-refresh-one").forEach(b => b.addEventListener("click", async e => {
    e.stopPropagation();
    const id = e.currentTarget.dataset.id;
    await refreshOne(id);
  }));
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
  /* show guessed Yahoo-symbol as placeholder for unconfigured tickers */
  $("#edit-yahoo-symbol").placeholder = `Vorgeschlagen: ${API._guessYahooSymbol(t) || "—"}`;
  /* reset lookup UI */
  $("#edit-td-results").hidden = true;
  $("#edit-td-results").innerHTML = "";
  $("#edit-td-status").hidden = true;
  $("#edit-td-status").textContent = "";
  renderAlertEditor(t.user.alerts || []);
  openModal("#modal-edit");
}
function renderAlertEditor(alerts) {
  const host = $("#edit-alerts-list");
  host.innerHTML = alerts.map((a, i) => `
    <div class="alert-row" data-idx="${i}">
      <select class="al-type">
        <option value="price_below" ${a.type==="price_below"?"selected":""}>Preis ≤</option>
        <option value="price_above" ${a.type==="price_above"?"selected":""}>Preis ≥</option>
        <option value="rsi_above"   ${a.type==="rsi_above"  ?"selected":""}>RSI ≥</option>
        <option value="rsi_below"   ${a.type==="rsi_below"  ?"selected":""}>RSI ≤</option>
        <option value="ma20_below"  ${a.type==="ma20_below" ?"selected":""}>Preis ≤ MA20</option>
      </select>
      <input class="al-th" type="number" step="any" value="${a.threshold ?? ""}" placeholder="Schwelle" />
      <button class="al-del" aria-label="Alert löschen"><i data-lucide="x" class="icon icon-sm"></i></button>
    </div>
  `).join("");
  host.querySelectorAll(".al-del").forEach(b => b.addEventListener("click", e => {
    e.currentTarget.closest(".alert-row").remove();
  }));
  if (window.lucide) lucide.createIcons();
}
function collectAlertsFromEditor() {
  return $$("#edit-alerts-list .alert-row").map(row => {
    const type = row.querySelector(".al-type").value;
    const th   = row.querySelector(".al-th").value;
    if (th === "" || isNaN(+th)) return null;
    return { type, threshold: +th };
  }).filter(Boolean);
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
  /* if user picked a lookup result, also propagate exchange + currency */
  const choice = Store.state.ui.tdLookupChoice;
  if (choice) {
    if (choice.exchange) t.stamm.twelvedata_exchange = choice.exchange;
    if (choice.currency) t.stamm.currency = choice.currency;
    Store.patchUi({ tdLookupChoice: null });
  }
  t.user.alerts = collectAlertsFromEditor();
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
  $("#modal-nk-title").textContent = `${t.stamm.symbol} · Nachkauf-Kalkulator`;
  const entry  = t.user.entry_price_manual;
  const shares = t.user.entry_shares;
  const price  = t.quotes.price;
  $("#nk-context").innerHTML = `
    Einstand <b>${entry != null ? numFmt(entry) : "—"}</b> ·
    Stück <b>${shares != null ? numFmt(shares, 0) : "—"}</b> ·
    Live-Preis <b>${numFmt(price)}</b>
  `;
  $("#nk-pct").value   = CONFIG.defaults.nkPct;
  $("#nk-price").value = price != null ? price : "";
  recomputeNachkauf();
  openModal("#modal-nachkauf");
}
function recomputeNachkauf() {
  const id = Store.state.ui.nachkaufId;
  const t  = id && Store.byId(id);
  const out = $("#nk-out");
  if (!t) { out.innerHTML = ""; return; }
  const entry  = t.user.entry_price_manual;
  const shares = t.user.entry_shares;
  const pct    = +$("#nk-pct").value;
  const price  = +$("#nk-price").value;

  if (entry == null || shares == null || !shares || isNaN(pct) || !price) {
    out.innerHTML = `<div class="nk-out__row"><span class="nk-out__lbl">Hinweis</span><span class="nk-out__val dim">Einstand, Stück und Nachkauf-Kurs erforderlich</span></div>`;
    return;
  }
  const oldValue = entry * shares;
  const addValue = oldValue * (pct / 100);
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
    ` : ""}
  `;
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
  "tradingview_url","twelvedata_symbol","twelvedata_mic_code","twelvedata_exchange",
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
          entry_price_start: null, alerts: [],
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
    const res = await refreshFn(list);
    list.forEach(Calc.recompute);
    Store.save();
    Render.bucket();
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
const refreshAll    = () => refreshList(Store.state.tickers, "Einträge aktualisiert");
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
  const lblMap = { price_below:"Preis ≤", price_above:"Preis ≥", rsi_above:"RSI ≥", rsi_below:"RSI ≤", ma20_below:"Preis ≤ MA20" };
  const body = $("#modal-alerts-body");
  if (!items.length) {
    body.innerHTML = `<div class="alert-overview__empty">Keine Alerts definiert</div>`;
  } else {
    body.innerHTML = `<div class="alert-overview">${items.map(({t,a}) => `
      <div class="alert-overview__item ${a._trig ? "is-trig" : ""}">
        <span class="alert-overview__sym">${t.stamm.symbol}</span>
        <span class="alert-overview__type">${lblMap[a.type] || a.type}</span>
        <span class="alert-overview__val">${numFmt(a.threshold)} ${a._trig ? "·  ⚠ ausgelöst" : ""}</span>
      </div>
    `).join("")}</div>`;
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
  $$(".td-result").forEach(el => el.classList.remove("is-active"));
  const active = [...$$(".td-result")].find(el => el.querySelector(".td-result__sym").textContent === r.symbol);
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
  $("#btn-config")     .addEventListener("click", openConfig);
  $("#btn-blob")       .addEventListener("click", e => saveBlob(e.currentTarget));
  $("#btn-json-import").addEventListener("click", () => openModal("#modal-import"));
  $("#btn-json-export").addEventListener("click", exportJson);
  $("#menu-nav")       .addEventListener("click", () => { Store.patchUi({ menuOpen: !Store.state.ui.menuOpen }); Render.menu(); });

  // sub bar
  $("#btn-element-card-view") .addEventListener("click", () => { Store.patchUi({ view: "cards" }); Render.viewMode(); });
  $("#btn-element-table-view").addEventListener("click", () => { Store.patchUi({ view: "table" }); Render.viewMode(); });
  $("#btn-element-refresh")     .addEventListener("click", () => refreshBucket(Store.state.ui.bucket));
  $("#btn-element-fullrefresh") .addEventListener("click", refreshAll);
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
  $("#nav-bottom-element-home") .addEventListener("click", () => { Store.patchUi({ triggeredOnly: false, selected: [] }); Render.all(); });
  $("#nav-bottom-element-alert").addEventListener("click", openAlertsOverview);
  $("#nav-bottom-element-dropdown").addEventListener("change", e => {
    Store.patchUi({ bucket: e.target.value, selected: [] });
    Render.bucket(); Render.bulkbar();
  });

  // side menu
  $("#menu-nav-btn-screener") .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); });
  $("#menu-nav-btn-config")   .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); openConfig(); });
  $("#menu-nav-btn-cloud-load").addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); loadBlob({ silent: false }); });
  $("#menu-nav-btn-cloud-save").addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); saveBlob(null); });
  $("#nav-sheet-close")       .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); });
  $("#nav-scrim")             .addEventListener("click", () => { Store.patchUi({ menuOpen:false }); Render.menu(); });

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
    renderAlertEditor(cur);
  });

  // nachkauf
  $("#nk-pct")  .addEventListener("input", recomputeNachkauf);
  $("#nk-price").addEventListener("input", recomputeNachkauf);

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
}

/* ════════════════════════════════════════════════════
   SECTION 7 — INIT
   ════════════════════════════════════════════════════ */
function init() {
  console.log("[init] Merkliste boot");
  Store.load();
  Calc.recomputeAll();
  bindEvents();
  Render.all();
  if (window.lucide) lucide.createIcons();
  console.log("[init] ready", Store.state);
  /* Hybrid sync: load from cloud silently in background, merge if newer */
  loadBlob({ silent: true });
}
document.addEventListener("DOMContentLoaded", init);
