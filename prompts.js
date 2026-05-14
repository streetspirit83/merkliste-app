/* ════════════════════════════════════════════════════
   PROMPTS — KI-Update Vorlagen
   Platzhalter: {{symbol}}, {{name}}, {{exchange}}, {{sector}},
                {{price}}, {{day_change_pct}}, {{currency}},
                {{ma20}}, {{ma50}}, {{ma200}}, {{rsi}},
                {{trend_reason}}, {{core_business}}, {{why_not}},
                {{notes}}, {{asset_type}}, {{market_cap_size}}
   ════════════════════════════════════════════════════ */
const PROMPTS = [
  {
    id: "trend_update",
    label: "Trend & News Update",
    template: `Analysiere {{name}} ({{symbol}}, {{exchange}}, {{sector}}).

Aktueller Kurs: {{price}} {{currency}} ({{day_change_pct}}% heute)
MA20: {{ma20}} | MA50: {{ma50}} | MA200: {{ma200}} | RSI: {{rsi}}

Bisheriger Trend-Grund: {{trend_reason}}
Geschäftsmodell: {{core_business}}

Bitte liefere ein aktualisiertes JSON-Objekt mit folgenden Feldern:
{
  "trend_reason": "...",
  "recent_news": ["...", "..."],
  "next_catalysts": ["...", "..."],
  "sentiment": "bullish | neutral | bearish",
  "why_not": "..."
}`
  },
  {
    id: "business_update",
    label: "Geschäftsmodell Update",
    template: `Beschreibe das aktuelle Geschäftsmodell von {{name}} ({{symbol}}).
Sektor: {{sector}} | Typ: {{asset_type}} | Größe: {{market_cap_size}}

Bisherige Beschreibung: {{core_business}}

Liefere ein aktualisiertes JSON:
{
  "core_business": "...",
  "sector": "...",
  "sub_sector": "...",
  "market_cap_size": "large | mid | small"
}`
  },
  {
    id: "full_scan",
    label: "Full Scout Scan",
    template: `Führe einen vollständigen Analyse-Scan für {{name}} ({{symbol}}, {{exchange}}) durch.

Kurs: {{price}} {{currency}} | Tag: {{day_change_pct}}%
Technisch: MA20={{ma20}} MA50={{ma50}} MA200={{ma200}} RSI={{rsi}}
Sektor: {{sector}} | Typ: {{asset_type}}
Notizen: {{notes}}

Liefere ein vollständiges JSON-Objekt für den Trend-Scout mit allen relevanten Feldern:
{
  "core_business": "...",
  "trend_reason": "...",
  "recent_news": ["..."],
  "next_catalysts": ["..."],
  "sentiment": "bullish | neutral | bearish",
  "why_not": "...",
  "priority": "high | medium | low"
}`
  }
];

/* Füllt Platzhalter mit flachem Ticker-Objekt */
function fillPrompt(template, t) {
  const fmt = v => (v == null ? "—" : typeof v === "number" ? v.toLocaleString("de-DE", { maximumFractionDigits: 2 }) : v);
  return template
    .replace(/\{\{symbol\}\}/g,         fmt(t.symbol))
    .replace(/\{\{name\}\}/g,           fmt(t.name))
    .replace(/\{\{exchange\}\}/g,       fmt(t.exchange))
    .replace(/\{\{sector\}\}/g,         fmt(t.sector))
    .replace(/\{\{asset_type\}\}/g,     fmt(t.asset_type))
    .replace(/\{\{market_cap_size\}\}/g,fmt(t._raw?.stamm?.market_cap_size))
    .replace(/\{\{price\}\}/g,          fmt(t.price))
    .replace(/\{\{day_change_pct\}\}/g, fmt(t.day_change_pct))
    .replace(/\{\{currency\}\}/g,       fmt(t.currency_returned || t.currency))
    .replace(/\{\{ma20\}\}/g,           fmt(t.ma20))
    .replace(/\{\{ma50\}\}/g,           fmt(t.ma50))
    .replace(/\{\{ma200\}\}/g,          fmt(t.ma200))
    .replace(/\{\{rsi\}\}/g,            fmt(t.rsi))
    .replace(/\{\{trend_reason\}\}/g,   fmt(t._raw ? eff(t._raw, "trend_reason") : null))
    .replace(/\{\{core_business\}\}/g,  fmt(t._raw ? eff(t._raw, "core_business") : null))
    .replace(/\{\{why_not\}\}/g,        fmt(t._raw ? eff(t._raw, "why_not") : null))
    .replace(/\{\{notes\}\}/g,          fmt(t._raw?.user?.notes));
}
