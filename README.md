# Merkliste — Deployment auf Netlify

Persönliches Watchlist- und Portfolio-Tracker-Tool. Single-file frontend mit zwei Netlify-Functions für Yahoo-Fallback und Cloud-Storage.

## Dateistruktur

```
merkliste/
├── index.html               ← Static, lädt styles.css + app.js
├── styles.css               ← Design-Tokens und Komponenten-CSS
├── app.js                   ← Schema-A, API, Calc, Render, Events
├── netlify.toml             ← Build- und Functions-Konfig
├── package.json             ← Dependencies (@netlify/blobs)
└── netlify/
    └── functions/
        ├── yahoo-quote.js   ← CORS-Proxy zu Yahoo Finance /v8/finance/chart
        └── blob.js          ← Cloud-Storage via Netlify Blobs
```

## Erstes Deploy

### Option A — Drag & Drop (schnellster Weg)

1. Diesen Ordner als ZIP packen
2. https://app.netlify.com/drop öffnen
3. ZIP hineinziehen → Netlify deployed automatisch
4. Beim ersten Build werden Functions installiert (`@netlify/blobs` aus package.json)
5. URL kopieren (z.B. `https://random-name-abc.netlify.app`)

### Option B — CLI

```bash
npm install -g netlify-cli
cd merkliste
netlify deploy --prod
```

## Erste Schritte nach Deployment

1. App öffnen — leere Liste, CTA "JSON importieren"
2. Settings-Icon ⚙ oben links → **Twelve Data API Key** eintragen
   (kostenlos auf https://twelvedata.com — Free-Tier: 800 Calls/Tag, 8/min)
3. Eigene JSON-Daten via Import-Modal hineinladen
4. Daten werden automatisch lokal gespeichert (localStorage)
5. Burger-Menü oben rechts → **"In Cloud sichern"** klicken → Daten landen in Netlify Blobs
6. Auf anderem Gerät dieselbe URL öffnen → beim Start wird automatisch aus Cloud geladen (silent)

## Funktionsweise

### Refresh-Modi

| Button | Endpoint(s) | Was wird geholt | Credits |
|---|---|---|---|
| ⟳ Quick | TD `/quote` | Aktueller Preis, Tages-%, Volumen | 1 / Ticker |
| 🗄 Full | TD `/quote` + `/time_series` (210d) | Quick + MA20/50/200, RSI, MACD (lokal berechnet) | 2 / Ticker |

### Yahoo-Fallback (automatisch)

Wenn TD für ein Symbol fehlschlägt (404, ungültig, Rate-Limit), wird transparent Yahoo Finance via Netlify-Function probiert:

- Quick: nur Quote-Daten
- Full: Quote + bis zu 210 historische Closes für MA/RSI/MACD-Berechnung
- `_source` im Ticker-Block zeigt `"yahoo"` statt `"twelvedata"`
- Yahoo-Symbol kann pro Ticker im Edit-Modal überschrieben werden — sonst wird heuristisch aus MIC-Code abgeleitet (`XETR` → `.DE`, `XSTO` → `.ST`, etc.)

**⚠ Yahoo-Caveat:** Yahoo Finance hat 2024/2025 ihre Anti-Scraping-Maßnahmen verschärft. Die Function (`yahoo-quote.js`) versucht `query2` + 3 verschiedene User-Agents als Fallback-Strategie. In den meisten Fällen funktioniert das aus Netlify-Production-Umgebungen, kann aber bei aggressiven Rate-Limits 502/403 zurückgeben. Bei häufigen Yahoo-Ausfällen: Symbol-Override im Edit-Modal mit alternativen Yahoo-Tickern testen oder TD-Quote für die Spalten reichen lassen.

### Cloud-Storage (Netlify Blobs)

- **Auto-Load beim App-Start** (silent — nur wenn cloud-savedAt > local-lastSyncTs ODER local leer)
- **Manueller Save** über Burger-Menü oder Cloud-Upload-Button in Topbar
- **Manueller Load** über Burger-Menü "Aus Cloud laden"
- Anonymer single-key Modus: alle Geräte teilen sich denselben Eintrag (`merkliste/main`)
- Netlify Blobs ist automatisch konfiguriert wenn Site auf Netlify gehostet ist — keine Env-Vars nötig

### Konflikt-Strategie

Wenn lokale Daten **neuer** sind als Cloud (basierend auf Timestamps): kein Auto-Overwrite, nur Hinweis in der Console. Manuell saven um auf Cloud zu pushen.

## Updates ohne neues Deploy

`index.html` / `styles.css` / `app.js` editieren und committen — Netlify deployed bei Git-Push automatisch. Bei Drag & Drop: ZIP neu hochladen.

## Troubleshooting

| Problem | Ursache | Fix |
|---|---|---|
| "TD-Fehler: …" | Free-Tier Rate-Limit erreicht (8 Calls/min) | 1 Min warten oder Plan upgraden |
| "Yahoo HTTP 401/429" | Yahoo blockt zu viele Requests | UA-Spoof in `yahoo-quote.js` greift normalerweise — falls trotzdem: 5 Min warten |
| "Cloud-Save fehlgeschlagen" | Netlify-Function nicht deployed | Prüfe `netlify.toml` und dass `netlify/functions/blob.js` im Repo ist |
| Symbol nicht in TD findbar | exotische Börse / Crypto | Yahoo-Symbol im Edit-Modal manuell setzen (z.B. `BTC-USD`) |

## Datenschutz

Da das Tool anonym läuft und alle Geräte denselben Cloud-Blob teilen: **Niemand außer dir sollte die URL kennen**. Die Site ist nicht passwortgeschützt. Für mehrere User: Netlify Identity einrichten oder einen URL-Suffix als "Pseudo-Auth" nutzen.

## Code-Sektionen (app.js)

```
§1  CONFIG          Storage-Keys, Endpoints, Defaults
§2  SCHEMA A        Ticker-Datenmodell + Store + eff() Helper
§3  API ADAPTERS    Twelve Data + Yahoo Fallback
§4  BUSINESS LOGIC  Sentiment, Position, Indicators (SMA/RSI/MACD)
§5  RENDER          Cards + Table + Modals
§6  EVENTS          Modals, Bulk-Aktionen, Refresh, Cloud-Sync
§7  INIT            DOMContentLoaded → boot
```
