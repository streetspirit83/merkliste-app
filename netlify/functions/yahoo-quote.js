/**
 * yahoo-quote.js
 * Proxy für Yahoo-Finance /v8/finance/chart endpoint.
 * Umgeht CORS-Restriktion für Browser-direct-calls.
 *
 * Query-Params:
 *   symbol   (required) — z.B. "SAP.DE", "NVDA", "OX2.ST"
 *   history  (optional) — "1" → liefert auch 210 closes
 *
 * Response:
 *   { quote: {...}, closes: [number, ...] }  oder  { error: "msg" }
 */

const YAHOO_BASES = [
  "https://query2.finance.yahoo.com/v8/finance/chart",
  "https://query1.finance.yahoo.com/v8/finance/chart"
];

const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0"
];

async function fetchYahoo(symbol, withHistory) {
  const params = new URLSearchParams({
    interval: "1d",
    range: withHistory ? "1y" : "1d",
    includePrePost: "false"
  });
  let lastErr = null;
  /* try each base + UA combination */
  for (let i = 0; i < YAHOO_BASES.length; i++) {
    for (let j = 0; j < 2; j++) {
      const target = `${YAHOO_BASES[i]}/${encodeURIComponent(symbol)}?${params}`;
      try {
        const res = await fetch(target, {
          headers: {
            "User-Agent": UA_POOL[(i + j) % UA_POOL.length],
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer": "https://finance.yahoo.com/",
            "Origin": "https://finance.yahoo.com"
          }
        });
        if (res.ok) return { ok: true, data: await res.json() };
        lastErr = `HTTP ${res.status}`;
        /* 404 is final — don't retry */
        if (res.status === 404) return { ok: false, error: "not-found", status: 404 };
      } catch (err) {
        lastErr = err.message;
      }
    }
  }
  return { ok: false, error: lastErr || "Yahoo unreachable" };
}

export default async (req) => {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol");
  const withHistory = url.searchParams.get("history") === "1";

  if (!symbol) {
    return new Response(JSON.stringify({ error: "Missing symbol" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const fetched = await fetchYahoo(symbol, withHistory);
  if (!fetched.ok) {
    return new Response(JSON.stringify({ error: fetched.error }), {
      status: fetched.status === 404 ? 404 : 502,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const data = fetched.data;
    const result = data?.chart?.result?.[0];
    if (!result) {
      const errCode = data?.chart?.error?.code || "no-result";
      const errDesc = data?.chart?.error?.description || "No result";
      return new Response(JSON.stringify({ error: `${errCode}: ${errDesc}` }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const meta = result.meta || {};
    const ind  = result.indicators?.quote?.[0] || {};

    /* normalize quote fields */
    const prev = meta.regularMarketPreviousClose ?? meta.previousClose ?? meta.chartPreviousClose;
    const last = meta.regularMarketPrice;
    const pct  = (prev && last != null) ? ((last - prev) / prev) * 100 : null;
    const quote = {
      symbol: meta.symbol,
      currency: meta.currency,
      fullExchangeName: meta.fullExchangeName || meta.exchangeName,
      regularMarketPrice: last,
      regularMarketVolume: meta.regularMarketVolume,
      regularMarketChangePercent: pct,
      previousClose: prev,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow:  meta.fiftyTwoWeekLow,
      fiftyTwoWeekHighChangePercent:
        (meta.fiftyTwoWeekHigh && last != null) ? ((meta.fiftyTwoWeekHigh - last) / last) * 100 : null,
      fiftyTwoWeekLowChangePercent:
        (meta.fiftyTwoWeekLow && last != null)  ? ((last - meta.fiftyTwoWeekLow) / meta.fiftyTwoWeekLow) * 100 : null
    };

    let closes = null;
    if (withHistory && Array.isArray(ind.close)) {
      closes = ind.close.filter(v => v != null && !isNaN(+v)).map(Number);
      if (closes.length > 210) closes = closes.slice(-210);
    }

    return new Response(JSON.stringify({ quote, closes }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

export const config = { path: "/.netlify/functions/yahoo-quote" };
