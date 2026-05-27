/* ============================================================
   trendscout-prompts.js
   Daten-Konstanten, Schema-Block und Prompt-Builder
   für den Trend-Scout Prompt-Generator.
   Wird von trendscout.html per <script src> eingebunden.
   ============================================================ */

// ──────────────────────────────────────────────────────────────
// STAMMDATEN
// ──────────────────────────────────────────────────────────────

const MARKETS     = ['US', 'DE', 'EU', 'ETF'];
const MARKET_CAPS = ['Large', 'Mid', 'Small', 'Micro'];

const SECTORS = [
  'Technologie', 'Halbleiter', 'Software', 'Internet & E-Commerce',
  'Healthcare', 'Pharma', 'Biotech', 'Medizintechnik',
  'Energie (Öl/Gas)', 'Erneuerbare Energien', 'Utilities',
  'Financials', 'Banken', 'Versicherungen', 'Immobilien',
  'Industrials', 'Maschinenbau', 'Rüstung', 'Logistik',
  'Consumer Staples', 'Consumer Discretionary', 'Luxus',
  'Automotive', 'Chemie', 'Rohstoffe & Bergbau',
  'Telekom', 'Medien', 'Sonstiges',
];

// Swing/Trend-Kriterien
const SWING_CRITERIA = [
  { key: 'news',        label: 'News-getrieben',   desc: 'Earnings, Upgrades, M&A, Regulierung' },
  { key: 'technical',   label: 'Technisch',         desc: '52W-Ausbruch, Momentum, Volumen, Kreuze' },
  { key: 'fundamental', label: 'Fundamental',       desc: 'Revisionen nach oben, KGV/Wachstum' },
  { key: 'rotation',    label: 'Sektor-Rotation',   desc: 'Heiße Sektoren aktuell' },
  { key: 'contra',      label: 'Kontra / Oversold', desc: 'Fundamental intakt, aber abgestraft' },
  { key: 'sentiment',   label: 'Social Sentiment',  desc: 'StockTwits, Reddit, X-Cashtags' },
];

// Long-/Positionstrading-Kriterien
const LONG_CRITERIA = [
  { key: 'fundamental', label: 'Fundamentale Qualität', desc: 'Bilanz, ROIC, Free Cashflow, Gewinnmargen' },
  { key: 'moat',        label: 'Burggraben / Moat',     desc: 'Netzwerkeffekte, Wechselkosten, Markenstärke, Preismacht' },
  { key: 'growth',      label: 'Wachstumsdynamik',      desc: 'Revenue-Wachstum, TAM-Erschließung, Marktanteilsgewinne' },
  { key: 'valuation',   label: 'Bewertung / PEG',       desc: 'KGV, EV/EBITDA, KUV im Verhältnis zum Wachstum' },
  { key: 'catalyst',    label: 'Langfrist-Katalysator', desc: 'Megatrend, regulatorischer Rückenwind, Disruption' },
  { key: 'technical',   label: 'Entry-Timing',          desc: 'Technische Unterstützung, Trend, sinnvolles Einstiegsfenster' },
];

// Contrarian-Kriterien
const CONTRARIAN_CRITERIA = [
  { key: 'quality',        label: 'Kerngeschäft intakt?',  desc: 'Trotz Kursrückgang: Ist das Geschäftsmodell gesund?' },
  { key: 'selloff_reason', label: 'Abverkauf temporär?',   desc: 'Miss, Rotation, Makro-Überreaktion — nicht strukturell' },
  { key: 'insider',        label: 'Insider-Käufe',          desc: 'C-Level-Käufe, Aktienrückkäufe als Vertrauenssignal' },
  { key: 'sentiment',      label: 'Sentiment-Extrem',       desc: 'Wie negativ ist die Stimmung? Kapitulation sichtbar?' },
  { key: 'valuation',      label: 'Relativer Discount',     desc: 'Rabatt gegenüber historischen Multiples und Peers' },
  { key: 'reversal',       label: 'Reversal-Signale',       desc: 'Doji, Hammer, RSI-Divergenz, Bodenbildung sichtbar' },
];

// ETF-Filter
const ETF_CATEGORIES = ['Themen-ETF', 'Sektor-ETF', 'Regionen-ETF', 'Faktor-ETF', 'Anleihen-ETF', 'Rohstoff-ETF'];
const ETF_REGIONS    = ['Global', 'USA', 'Europa', 'Emerging Markets', 'Asien-Pazifik'];
const ETF_PROVIDERS  = ['iShares', 'Xtrackers', 'SPDR', 'Invesco', 'Amundi', 'Vanguard', 'WisdomTree'];

// Future-Technologie-Themen
const THEME_PRESETS = [
  {
    key: 'renewable',
    label: 'Erneuerbare Energien',
    intro: 'Werte in der Energie-Wende: Erzeugung, Komponenten, Service.',
    subs: [
      { name: 'Solar',                   desc: 'Modul-Hersteller, Wechselrichter, Tracker, Polysilicon, Solar-EPC' },
      { name: 'Wind',                    desc: 'Onshore + Offshore Turbinen-Hersteller, Service, Komponentenzulieferer' },
      { name: 'Wasserstoff',             desc: 'Elektrolyseure, H2-Mobility, grüner Stahl, Brennstoffzellen' },
      { name: 'Geothermie / Kernenergie',desc: 'SMR-Reaktoren, Next-Gen-Kernkraft, Geothermie-Player, Uran-Miner' },
    ],
  },
  {
    key: 'storage_grid',
    label: 'Energiespeicher & Netz',
    intro: 'Speicher-Infrastruktur und Stromnetz-Modernisierung als Kern der Energiewende.',
    subs: [
      { name: 'Batterien stationär',  desc: 'BESS / Grid-Scale Storage, Heimspeicher, kommerzielle Batterie-Systeme' },
      { name: 'Batterien Auto',       desc: 'LFP, NMC, Solid-State (frühphasig), Battery-Management-Systeme' },
      { name: 'Netz-Infrastruktur',   desc: 'HVDC, Smart Grid, Aggregatoren / Flexibilität, Netz-Komponenten' },
      { name: 'Long-Duration Storage',desc: 'Iron-Air, Flow-Batteries, Gravity Storage, Wärmespeicher' },
    ],
  },
  {
    key: 'mobility',
    label: 'Mobilität der Zukunft',
    intro: 'Elektrifizierung, Autonomie und neue Mobilitätsformen.',
    subs: [
      { name: 'E-Fahrzeuge & Charging', desc: 'EV-Hersteller, Charging-Netze, Charging-Hardware' },
      { name: 'Autonomes Fahren',        desc: 'Software-Stacks (L4/L5), Lidar-Hersteller, Sensorik, Robotaxi-Operations' },
      { name: 'E-VTOL / Urban Air',      desc: 'Joby, Archer, Lilium-Klasse — sehr spekulativ, pre-revenue' },
      { name: 'Schiene & schwere Mobilität', desc: 'Wasserstoff-Züge, E-Trucks, elektrifizierte Baumaschinen' },
    ],
  },
  {
    key: 'ai_compute',
    label: 'AI & Compute-Infrastruktur',
    intro: 'AI-Hardware, Datacenter, Quantum — die Rechen-Schicht.',
    subs: [
      { name: 'AI-Chips',          desc: 'NVIDIA-Alternativen, Custom-Silicon (Hyperscaler), Inference-Chips, Edge-AI' },
      { name: 'AI-Datacenter',     desc: 'Hyperscaler-Bauer, Liquid-Cooling, Networking (InfiniBand, Optical)' },
      { name: 'AI-Software & Tools',desc: 'AI-Plattformen, MLOps, AI-Application-Layer, AI-Sicherheit' },
      { name: 'Quantum Computing', desc: 'IonQ, Rigetti, Quantinuum-Klasse — sehr spekulativ' },
    ],
  },
  {
    key: 'biotech_future',
    label: 'Biotech & Healthcare-Future',
    intro: 'Gen-Therapien, GLP-1, Longevity, Brain-Computer-Interfaces.',
    subs: [
      { name: 'Gene Editing & Cell-Therapy', desc: 'CRISPR-Werkzeuge, CAR-T, in-vivo Gen-Therapien' },
      { name: 'GLP-1 & Stoffwechsel',        desc: 'Semaglutid-Folger, oral GLP-1, GLP-1-Pipeline' },
      { name: 'Anti-Aging / Longevity',      desc: 'Senolytika, NAD+, Biomarker-Diagnostik (sehr spekulativ)' },
      { name: 'Brain-Computer Interfaces',   desc: 'Neuralink-Klasse, nicht-invasive BCIs (sehr spekulativ)' },
    ],
  },
  {
    key: 'defense_security',
    label: 'Defense & Security',
    intro: 'Verteidigung, Drohnen, Satelliten, Cyber.',
    subs: [
      { name: 'Drohnen & unbemannte Systeme', desc: 'Militärische UAVs, Counter-Drone-Tech, Loitering Munition' },
      { name: 'Satelliten & Space-Defense',   desc: 'Earth Observation, militärische Sat-Comm, Hypersonic-Tracking' },
      { name: 'Cyber-Security',               desc: 'Endpoint, Cloud-Security, Identity, Zero-Trust' },
      { name: 'Klassische Defense-Primes',    desc: 'Etablierte Rüstungskonzerne, mit Fokus auf neue Programme' },
    ],
  },
  {
    key: 'frontier',
    label: 'Frontier & Robotik',
    intro: 'Humanoide Roboter, Space-Economy, sonstige Frontier-Themen.',
    subs: [
      { name: 'Humanoide Roboter',    desc: 'Tesla Optimus-Klasse, Figure, 1X — Hardware + Software' },
      { name: 'Industrielle Robotik', desc: 'Cobots, Lager-Automation, AMRs, Vision-Systeme' },
      { name: 'Space-Economy',        desc: 'Launch-Provider, Satelliten-Konstellationen, Space-Mining (sehr früh)' },
      { name: 'Crypto-Adjacent Equities', desc: 'Miner, Custody, Krypto-ETFs, Stablecoin-Infra' },
    ],
  },
];

// Eingebaute Presets (nach Modus gruppiert)
const BUILTIN_PRESETS = [
  // ── Swing ──
  {
    id: 'builtin-energie-swing',
    builtin: true,
    mode: 'swing',
    name: 'Energie-Swing',
    markets: ['DE', 'EU'],
    sectors: ['Energie (Öl/Gas)', 'Erneuerbare Energien', 'Utilities'],
    marketCap: ['Large', 'Mid'],
    liquidityFilter: true,
    uptrendOnly: false,
    positiveEarningsOnly: false,
    weights: { news: 3, technical: 2, fundamental: 2, rotation: 2, contra: 1, sentiment: 1 },
    count: 10,
  },
  {
    id: 'builtin-ki-swing',
    builtin: true,
    mode: 'swing',
    name: 'KI-Momentum',
    markets: ['US'],
    sectors: ['Technologie', 'Halbleiter'],
    marketCap: ['Large', 'Mid'],
    liquidityFilter: true,
    uptrendOnly: true,
    positiveEarningsOnly: false,
    weights: { news: 2, technical: 3, fundamental: 1, rotation: 2, contra: 0, sentiment: 3 },
    count: 10,
  },
  // ── Long ──
  {
    id: 'builtin-qualitaet-long',
    builtin: true,
    mode: 'long',
    name: 'Qualitäts-Compounder',
    markets: ['US'],
    sectors: [],
    marketCap: ['Large', 'Mid'],
    liquidityFilter: true,
    dividendFocus: false,
    weights: { fundamental: 3, moat: 3, growth: 2, valuation: 2, catalyst: 2, technical: 1 },
    count: 5,
  },
  {
    id: 'builtin-europa-dividende',
    builtin: true,
    mode: 'long',
    name: 'Europa Dividende',
    markets: ['DE', 'EU'],
    sectors: ['Financials', 'Industrials', 'Consumer Staples', 'Utilities'],
    marketCap: ['Large'],
    liquidityFilter: true,
    dividendFocus: true,
    weights: { fundamental: 2, moat: 2, growth: 1, valuation: 3, catalyst: 1, technical: 1 },
    count: 5,
  },
  // ── Contrarian ──
  {
    id: 'builtin-kontra-us',
    builtin: true,
    mode: 'contrarian',
    name: 'US Kontra-Leader',
    markets: ['US'],
    sectors: [],
    marketCap: ['Large', 'Mid'],
    liquidityFilter: true,
    weights: { quality: 3, selloff_reason: 3, insider: 2, sentiment: 2, valuation: 2, reversal: 1 },
    count: 5,
  },
  {
    id: 'builtin-kontra-eu',
    builtin: true,
    mode: 'contrarian',
    name: 'EU Kontra-Value',
    markets: ['DE', 'EU'],
    sectors: ['Industrials', 'Automotive', 'Financials'],
    marketCap: ['Large', 'Mid'],
    liquidityFilter: true,
    weights: { quality: 2, selloff_reason: 2, insider: 2, sentiment: 1, valuation: 3, reversal: 2 },
    count: 5,
  },
];

// ──────────────────────────────────────────────────────────────
// GEMEINSAMER JSON SCHEMA-BLOCK
// Exakt passend zum Merkliste-Import (STAMM_FIELDS + FLAT_TO_USER)
// ──────────────────────────────────────────────────────────────

const COMMON_SCHEMA_BLOCK = `OUTPUT-FORMAT:
Antworte zunächst mit deiner Recherche und Analyse als Fließtext. Am ENDE gib einen Code-Block mit JSON in genau diesem Schema (dreifache Backticks mit "json"-Marker):

\`\`\`json
{
  "results": [
    {
      "symbol": "NVDA",
      "name": "NVIDIA Corp",
      "exchange": "NASDAQ",
      "asset_type": "Aktie",

      "sector": "Halbleiter",
      "sub_sector": "AI-Chips",
      "market_cap_size": "large",

      "currency": "USD",

      "core_business": "NVIDIA entwickelt GPUs und AI-Beschleuniger für Datacenter, Gaming und professionelle Visualisierung.",

      "trend_reason": "Anhaltende Nachfrage nach AI-Compute treibt Datacenter-Umsätze. Blackwell-Generation startet erfolgreich.",

      "recent_news": [
        "28. Apr: Q1-Zahlen über Erwartung, Datacenter +52% YoY",
        "22. Apr: Partnerschaft mit Hyperscaler XY angekündigt"
      ],

      "next_catalysts": [
        "Q2-Zahlen am 27. Aug",
        "GTC-Konferenz im Oktober"
      ],

      "why_not": "Hohe Bewertung, Konzentrationsrisiko bei wenigen Großkunden, mögliche AI-Capex-Sättigung.",

      "sentiment": "bullish",
      "priority": "hoch",

      "tradingview_url": "https://www.tradingview.com/symbols/NASDAQ-NVDA/",
      "stocktwits_url": "https://stocktwits.com/symbol/NVDA",

      "twelvedata_symbol": "NVDA",
      "twelvedata_mic_code": "XNGS",
      "twelvedata_exchange": "NASDAQ",

      "yahoo_symbol": "NVDA"
    }
  ]
}
\`\`\`

FELDER (alle Textfelder auf Deutsch):
- core_business: 1 Satz, was das Unternehmen wirklich macht (kein Marketing-Sprech)
- trend_reason: warum gerade jetzt relevant — konkrete Zahlen, Ereignisse, Daten
- recent_news: 1–3 Bullets, jüngste Entwicklungen mit Datum (DD. MMM)
- next_catalysts: 0–3 erwartete Ereignisse mit Datum/Zeitfenster. Leeres Array wenn nichts bekannt.
- why_not: konkrete Risiken, KEIN Marketing-Disclaimer, ehrlich benennen was schiefgehen kann
- sentiment: gesamtes aktuelles Markt-Sentiment zum Wert

ENUMS (exakt diese Werte, keine anderen):
- sentiment: "bullish" | "neutral" | "bearish"
- priority: "hoch" | "mittel" | "niedrig"
- asset_type: "Aktie" | "ETF"
- market_cap_size: "micro" (unter 300 Mio) | "small" (300 Mio – 2 Mrd) | "mid" (2–50 Mrd) | "large" (über 50 Mrd)
- sector: EXAKT einer aus: "Technologie" | "Halbleiter" | "Software" | "Internet & E-Commerce" | "Healthcare" | "Pharma" | "Biotech" | "Medizintechnik" | "Energie (Öl/Gas)" | "Erneuerbare Energien" | "Utilities" | "Financials" | "Banken" | "Versicherungen" | "Immobilien" | "Industrials" | "Maschinenbau" | "Rüstung" | "Logistik" | "Consumer Staples" | "Consumer Discretionary" | "Luxus" | "Automotive" | "Chemie" | "Rohstoffe & Bergbau" | "Telekom" | "Medien" | "Sonstiges"
- sub_sector: kurze Bezeichnung des spezifischen Teilbereichs (z.B. "AI-Chips", "Solar-Inverter", "GLP-1-Therapeutika"). Leerer String wenn nicht spezialisierbar.

TRADINGVIEW-URL: https://www.tradingview.com/symbols/{EXCHANGE}-{TICKER}/ — Hauptmarkt verwenden.

STOCKTWITS-URL: https://stocktwits.com/symbol/{TICKER} — für XETRA-Werte ggf. {TICKER}.DE falls nötig.

TWELVEDATA-FELDER (alle drei für jeden Wert):
- twelvedata_symbol: nackter Ticker OHNE Suffix (z.B. "NVDA", "SAP", "BMW")
- twelvedata_mic_code: ISO-MIC-Code der Hauptbörse:
  XNGS = NASDAQ Global Select Market (Standard für NASDAQ-Werte)
  XNYS = NYSE
  ARCX = NYSE Arca (ETFs)
  XETR = XETRA (Deutsche Börse)
  XLON = London Stock Exchange
  XPAR = Euronext Paris
  XAMS = Euronext Amsterdam
  XSWX = SIX Swiss Exchange
  XMIL = Borsa Italiana
  XMAD = Bolsa de Madrid
  XSTO = Nasdaq Stockholm
  XTKS = Tokyo Stock Exchange
  XHKG = Hong Kong Stock Exchange
  XTSE = Toronto Stock Exchange
- twelvedata_exchange: Anzeigename (NASDAQ, NYSE, XETRA, LSE, etc.)

WICHTIG:
- Begründungen konkret (Zahlen, Ereignisse, Quellen), nicht generisch
- KEINE Kursangaben — die App holt live-Preise über API
- KEINE Alert-Vorschläge — der Nutzer pflegt seine eigenen Alerts manuell
- JSON-Block MUSS valides JSON sein, ohne Kommentare, korrekt escapte Strings
- Genau EIN JSON-Block am Ende, alle Ergebnisse im "results"-Array`;

// ──────────────────────────────────────────────────────────────
// PROMPT BUILDER: Swing / Trend-Scan
// ──────────────────────────────────────────────────────────────

function buildSwingPrompt(cfg) {
  const activeWeights = Object.entries(cfg.weights).filter(([, v]) => v > 0);
  if (!activeWeights.length) return null;

  const weightDesc = activeWeights
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => {
      const t = SWING_CRITERIA.find(x => x.key === k);
      return `- ${t.label} (Gewicht ${v}/3): ${t.desc}`;
    }).join('\n');

  const markt      = cfg.markets.length   ? cfg.markets.join(', ')   : 'alle';
  const sektor     = cfg.sectors.length   ? cfg.sectors.join(', ')   : 'alle Sektoren';
  const cap        = cfg.marketCap.length ? cfg.marketCap.join(', ') : 'alle';
  const liquidity  = cfg.liquidityFilter
    ? '\n- Nur liquide Werte an etablierten Börsen (keine Pink Sheets, MarketCap > 500 Mio).'
    : '';
  const uptrend    = cfg.uptrendOnly
    ? '\n- ZWINGEND: Nur Werte mit intaktem charttechnischen Aufwärtstrend (Kurs über MA50 UND MA200, höhere Tiefs in 6-Monats-Historie, kein Crash unter MA200 in letzten 60 Tagen).'
    : '';
  const earnings   = cfg.positiveEarningsOnly
    ? '\n- ZWINGEND: Nur Werte mit jüngst positivem Earnings-Beat (letztes 1–2 Quartale: EPS- und/oder Revenue-Erwartung übertroffen, oder Guidance angehoben). Im trend_reason konkreten Quartalsbezug nennen.'
    : '';
  const zusatz     = cfg.extraNote?.trim() ? `\n\nZUSÄTZLICHE VORGABEN:\n${cfg.extraNote.trim()}` : '';

  return `Du bist ein erfahrener Aktien-Analyst. Recherchiere per Web-Suche ${cfg.count} aktuelle SWING-Kandidaten für Trades der nächsten 1–8 Wochen.

UNIVERSUM:
- Märkte: ${markt}
- Sektoren: ${sektor}
- Market Cap: ${cap}${liquidity}${uptrend}${earnings}

SWING-KRITERIEN (sortiert nach Gewicht, hohe Gewichte bevorzugen):
${weightDesc}

AUFGABE:
Liefere genau ${cfg.count} Werte, die aktuell (diese Woche) tatsächlich trenden. Nutze Web-Suche für:
- News der letzten 7 Tage (Earnings, Upgrades, Deals, Sektor-News)
- Technische Signale (52W-Hoch, Volumen-Spike, Ausbrüche)
- Social Sentiment (StockTwits, Reddit r/stocks r/wallstreetbets, X-Cashtags) — qualitativ
- Bevorstehende Termine (Earnings-Kalender, FDA-Termine, regulatorische Entscheidungen)

SWING-KONTEXT: Zeitrahmen 1–8 Wochen. Nur Werte, die ECHT diese Woche trenden — keine Standard-Favoriten ohne aktuellen Anlass.${zusatz}

${COMMON_SCHEMA_BLOCK}`;
}

// ──────────────────────────────────────────────────────────────
// PROMPT BUILDER: Long / Positionshandel
// ──────────────────────────────────────────────────────────────

function buildLongPrompt(cfg) {
  const activeWeights = Object.entries(cfg.weights).filter(([, v]) => v > 0);
  if (!activeWeights.length) return null;

  const weightDesc = activeWeights
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => {
      const t = LONG_CRITERIA.find(x => x.key === k);
      return `- ${t.label} (Gewicht ${v}/3): ${t.desc}`;
    }).join('\n');

  const markt  = cfg.markets.length   ? cfg.markets.join(', ')   : 'alle';
  const sektor = cfg.sectors.length   ? cfg.sectors.join(', ')   : 'alle Sektoren';
  const cap    = cfg.marketCap.length ? cfg.marketCap.join(', ') : 'alle';

  const liquidity = cfg.liquidityFilter
    ? '\n- Nur liquide Werte an etablierten Börsen (keine Pink Sheets, MarketCap > 500 Mio).'
    : '';
  const divFocus = cfg.dividendFocus
    ? '\n- FOKUS auf Dividendenzahler: solide, wachsende Dividende, Payout-Ratio tragbar. Dividendenrendite im trend_reason nennen.'
    : '';
  const zusatz = cfg.extraNote?.trim() ? `\n\nZUSÄTZLICHE VORGABEN:\n${cfg.extraNote.trim()}` : '';

  return `Du bist ein erfahrener Aktien-Analyst spezialisiert auf Qualitätsinvestments. Suche per Web-Suche ${cfg.count} LANGFRISTIGE Positionsideen für einen Zeithorizont von 6–24 Monaten.

UNIVERSUM:
- Märkte: ${markt}
- Sektoren: ${sektor}
- Market Cap: ${cap}${liquidity}${divFocus}

QUALITÄTS-KRITERIEN (sortiert nach Gewicht):
${weightDesc}

AUFGABE:
Liefere genau ${cfg.count} Werte, die FUNDAMENTAL ÜBERZEUGEN und aktuell ein attraktives Einstiegsfenster bieten. Nutze Web-Suche für:
- Fundamentale Kennzahlen (Revenue-Wachstum, Margen, Free Cashflow, Verschuldung, ROIC)
- Wettbewerbsstellung und Burggraben (Marktanteile, Pricing Power, Switching Costs)
- Bewertungsvergleich historisch und vs. Peers (KGV, EV/EBITDA, KUV, PEG-Ratio)
- Langfristige Wachstumstreiber und säkulare Megatrends
- Aktuelles Einstiegsfenster: Pullback, faire Bewertung, oder solider Aufwärtstrend

LONG-KONTEXT: Zeithorizont 6–24 Monate. Keine kurzfristigen Momentum-Plays. Im trend_reason klar machen WARUM JETZT ein guter Einstiegszeitpunkt ist (Bewertung, Pullback, Wachstumsphase). Keine Titel die bereits extrem überhitzt sind.${zusatz}

${COMMON_SCHEMA_BLOCK}`;
}

// ──────────────────────────────────────────────────────────────
// PROMPT BUILDER: Contrarian / Oversold
// ──────────────────────────────────────────────────────────────

function buildContrarianPrompt(cfg) {
  const activeWeights = Object.entries(cfg.weights).filter(([, v]) => v > 0);
  if (!activeWeights.length) return null;

  const weightDesc = activeWeights
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => {
      const t = CONTRARIAN_CRITERIA.find(x => x.key === k);
      return `- ${t.label} (Gewicht ${v}/3): ${t.desc}`;
    }).join('\n');

  const markt  = cfg.markets.length   ? cfg.markets.join(', ')   : 'alle';
  const sektor = cfg.sectors.length   ? cfg.sectors.join(', ')   : 'alle Sektoren';
  const cap    = cfg.marketCap.length ? cfg.marketCap.join(', ') : 'alle';

  const liquidity = cfg.liquidityFilter
    ? '\n- Nur liquide Werte an etablierten Börsen (keine Pink Sheets, MarketCap > 500 Mio).'
    : '';
  const zusatz = cfg.extraNote?.trim() ? `\n\nZUSÄTZLICHE VORGABEN:\n${cfg.extraNote.trim()}` : '';

  return `Du bist ein erfahrener Contrarian-Investor. Suche per Web-Suche ${cfg.count} FUNDAMENTAL SOLIDE Werte, die vom Markt aktuell ÜBERMÄSSIG ABGESTRAFT werden und ein Rebound-Potenzial haben.

UNIVERSUM:
- Märkte: ${markt}
- Sektoren: ${sektor}
- Market Cap: ${cap}${liquidity}

CONTRARIAN-KRITERIEN (sortiert nach Gewicht):
${weightDesc}

AUFGABE:
Liefere genau ${cfg.count} Werte mit echtem Contrarian-Potenzial. Nutze Web-Suche für:
- Werte die in den letzten 3–12 Monaten deutlich gefallen sind (20–60%), aber fundamentales Kerngeschäft intakt haben
- Ursachenanalyse: Warum der Abverkauf? Temporäres Miss, Sektor-Rotation, Makro-Angst, oder strukturelle Probleme?
- Insider-Aktivität: Aktuelle 13-F, Form 4, SEC-Filings — Insider-Käufe oder Rückkaufprogramme als Bullish-Signal
- Sentiment-Extreme: Analyst-Downgrades, Short-Interest, Fear-Indikatoren — Kapitulationssignale?
- Bewertungs-Discount: Historisches KGV, EV/EBITDA, P/Book aktuell vs. 5-Jahres-Schnitt und Peers
- Erste Reversal-Signale in der Charttechnik (Hammer, Doji, RSI-Divergenz)

CONTRARIAN-KONTEXT: Zeithorizont typisch 3–12 Monate (Rebound). Im trend_reason KLAR unterscheiden: Warum ist der Rückgang temporär? Warum ist das Kerngeschäft intakt? Im why_not unbedingt ehrlich bleiben: Wenn Risiken STRUKTURELL sind, nicht aufnehmen.

WICHTIG: Kein Billigkram oder Zombie-Stocks. Nur Werte mit nachgewiesener Unternehmensqualität die vorübergehend in Ungnade gefallen sind.${zusatz}

${COMMON_SCHEMA_BLOCK}`;
}

// ──────────────────────────────────────────────────────────────
// PROMPT BUILDER: ETF-Scan
// ──────────────────────────────────────────────────────────────

function buildEtfPrompt(cfg) {
  const categories = cfg.categories.length ? cfg.categories.join(', ') : 'alle Kategorien';
  const regions    = cfg.regions.length    ? cfg.regions.join(', ')    : 'global';
  const providers  = cfg.providers.length  ? `Bevorzugte Anbieter: ${cfg.providers.join(', ')}` : 'alle Anbieter';
  const thematic   = cfg.thematic?.trim()  ? `\n- Thematischer Fokus: ${cfg.thematic.trim()}` : '';
  const maxTer     = cfg.maxTer?.trim()    ? `\n- Maximale TER: ${cfg.maxTer.trim()}` : '';
  const listing    = cfg.listing?.trim()   ? `\n- Börsenlistung bevorzugt: ${cfg.listing.trim()}` : '';
  const zusatz     = cfg.extraNote?.trim() ? `\n\nZUSÄTZLICHE VORGABEN:\n${cfg.extraNote.trim()}` : '';

  return `Du bist ein ETF-Spezialist. Recherchiere per Web-Suche ${cfg.count} aktuell interessante ETFs nach folgenden Kriterien.

SUCHFILTER:
- Kategorien: ${categories}
- Regionen: ${regions}
- ${providers}${thematic}${maxTer}${listing}

AUFGABE:
Liefere genau ${cfg.count} ETFs. Nutze Web-Suche für:
- ETF-Datenbanken (justETF, etf.com, ETFdb, Morningstar ETF-Screener)
- Aktuelle Performance und Mittelzuflüsse (Flow-Daten der letzten 30–90 Tage)
- Thematische Aktualität: Welche Themen/Sektoren haben aktuell Rückenwind?
- Kostenvergleich (TER) und Größe (AUM) für Liquiditätseinschätzung
- Tracking-Qualität (Tracking Error, Replikationsmethode)

WICHTIG FÜR ETF-FELDER:
- asset_type: immer "ETF"
- core_business: Beschreibe was der ETF abbildet / trackt (Index, Thema, Strategie)
- trend_reason: Warum ist dieser ETF JETZT interessant? (Sektor-Momentum, Mittelzuflüsse, Bewertung)
- sub_sector: ETF-Kategorie aus: "Themen-ETF", "Sektor-ETF", "Regionen-ETF", "Faktor-ETF", "Anleihen-ETF", "Rohstoff-ETF"
- market_cap_size: "large" für ETFs mit AUM > 1 Mrd, "mid" für 100 Mio–1 Mrd, "small" für < 100 Mio
- why_not: Konzentrationsrisiken, Tracking Error, Währungsrisiko, Liquidität, Overlap mit Kernportfolio
- yahoo_symbol: wichtig für ETFs! UCITS-Variante wenn für DE/EU-Anleger relevant (z.B. "IWDA.AS")
- twelvedata_mic_code: XETR für XETRA-gelistete ETFs, ARCX für NYSE-Arca ETFs${zusatz}

${COMMON_SCHEMA_BLOCK}`;
}

// ──────────────────────────────────────────────────────────────
// PROMPT BUILDER: Einzel-Recherche (Symbol)
// ──────────────────────────────────────────────────────────────

function buildSymbolPrompt(symbol, hint) {
  const sym      = (symbol || '').trim().toUpperCase();
  const hintLine = hint?.trim() ? `\n- Börsen-Hinweis: ${hint.trim()}` : '';

  return `Du bist ein erfahrener Aktien-Analyst. Recherchiere per Web-Suche genau EINEN Wert tief und liefere ein vollständiges Profil.

ZIEL-WERT:
- Symbol/Ticker: ${sym}${hintLine}

AUFGABE:
1. Identifiziere den korrekten Wert (Name, Hauptbörse, Sektor)
2. Recherchiere per Web-Suche:
   - Aktuelle News der letzten 14 Tage (Earnings, Upgrades, Deals, Studien, Regulatorik)
   - Anstehende Katalysatoren (Earnings-Termin, Studienlesungen, Produkt-Launches)
   - Technische Lage und Sentiment (kurzqualitativ)
3. Fülle das vollständige Schema — auch wenn manche Felder kreativ recherchiert werden müssen
4. Bei why_not unbedingt ehrlich sein: konkrete Risiken, was kann schiefgehen

WICHTIG:
- Nur EINEN Wert im results-Array.
- Bei nicht eindeutigem Symbol (z.B. "SAP" = SAP SE oder SAP-Index): prominentesten Wert wählen und Entscheidung im Fließtext erklären.
- Bei nicht existierendem Symbol: results: [] und Erklärung im Fließtext.

${COMMON_SCHEMA_BLOCK}`;
}

// ──────────────────────────────────────────────────────────────
// PROMPT BUILDER: Hot Specs (hochspekulative Small-Caps)
// ──────────────────────────────────────────────────────────────

function buildHotPrompt(cfg) {
  const count     = cfg?.count  || 8;
  const region    = cfg?.region || 'global';
  const focus     = cfg?.focus?.trim();
  const focusLine = focus ? `\n- Thematischer Fokus: ${focus}` : '';
  const uptrend   = cfg?.uptrendOnly
    ? '\n- ZWINGEND: Nur Werte mit intaktem Aufwärtstrend in den letzten 3–6 Monaten (Kurs über MA50, höhere Tiefs trotz hoher Volatilität).'
    : '';

  return `Du bist ein Experte für hochspekulative Trades. Recherchiere per Web-Suche aktuelle "Hot Stocks" — kleine, stark diskutierte und hochvolatile Werte.

UNIVERSUM:
- Region: ${region}
- Market Cap: bevorzugt micro (unter 300 Mio) oder small (300 Mio–2 Mrd)${focusLine}${uptrend}
- Liquidität: handelbar an etablierten Börsen, KEIN Pink Sheet / OTC ohne Volumen

KRITERIEN (alle drei sollten zutreffen):
1. Aktuell heiß diskutiert: in den letzten 7 Tagen viel Aufmerksamkeit auf Reddit (r/wallstreetbets, r/pennystocks, r/SPACs), StockTwits, FinTwit (X), Discord-Communities
2. Spezifischer Trigger: konkreter aktueller Anlass (Studienergebnis, Vertrag, Patent, Übernahmegerücht, Short-Squeeze-Setup, Hype-Sektor)
3. Hochvolatil: Tagesschwankungen >5% in den letzten Tagen üblich

AUFGABE:
Liefere genau ${count} Werte. Nutze Web-Suche für:
- WSB Daily-Discussion-Threads, Trending-Listen
- StockTwits Trending-Liste
- X / FinTwit Cashtag-Trends
- Aktuelle SEC-Filings (8-K, S-1)
- Short-Interest-Daten (wenn relevant)

EHRLICHKEITS-GEBOT (KRITISCH):
- why_not MUSS konkrete Risiken nennen: Verwässerungsgefahr, hoher Cash-Burn, fehlende Profitabilität, Pump-Anzeichen, Reverse-Splits, Insider-Verkäufe, dilutive Capital Raises
- Bei pre-revenue / pre-FDA / hochspekulativ: deutliche Markierung im trend_reason
- Sentiment kann "bullish" sein, aber why_not bleibt nüchtern
- KEIN Schönreden, KEIN Hype-Modus

${COMMON_SCHEMA_BLOCK}

ZUSATZ-HINWEIS:
- market_cap_size sollte überwiegend "micro" oder "small" sein
- priority eher "niedrig" oder "mittel" (selbst wenn der Trade kurzfristig spannend ist — Position-Sizing!)`;
}

// ──────────────────────────────────────────────────────────────
// PROMPT BUILDER: Future-Themen (Sektor-Tiefenrecherche)
// ──────────────────────────────────────────────────────────────

function buildSectorPrompt(themeKey) {
  const theme = THEME_PRESETS.find(t => t.key === themeKey);
  if (!theme) return null;

  const subList = theme.subs.map((s, i) => `${i + 1}. ${s.name} — ${s.desc}`).join('\n');

  return `Du bist ein Experte für ${theme.label}. Recherchiere per Web-Suche aktuell relevante Werte aus diesem Bereich.

THEMENFELD: ${theme.label}
${theme.intro}

TEILBEREICHE (jeweils MINDESTENS 1, BEVORZUGT 2 Werte pro Teilbereich):
${subList}

AUFGABE:
Liefere insgesamt ${theme.subs.length * 2} Werte (2 pro Teilbereich), die aktuell (diese Woche) interessant sind. Mische:
- Etablierte Marktführer (large)
- Spezialisten / Pure-Plays (mid)
- Spannende kleinere Player (small)

Nutze Web-Suche für:
- Aktuelle News der letzten 14 Tage je Teilbereich
- Marktwachstum, Auftragsbücher, regulatorische Entwicklungen
- Sektor-Sentiment

WICHTIG:
- Diversifiziere ÜBER die Teilbereiche, nicht alle Werte in einen Bereich
- sub_sector-Feld muss den jeweiligen Teilbereich klar nennen
- Bei jüngeren Spekulationen (Quantum, Brain-Computer-Interfaces, Anti-Aging): why_not MUSS Pre-Revenue-/Pre-Profitabilitäts-Risiko explizit nennen

${COMMON_SCHEMA_BLOCK}`;
}
