# Merkliste App – Claude Code Notes

## Project Overview
Watchlist / portfolio tracker. Stores tickers (Stammdaten, quotes, user data like
`entry_price_manual`) in Netlify Blob Storage, fetches live prices from Yahoo, and
sends ntfy.sh push alerts via a scheduled function. UI is plain HTML/CSS/ES Modules
(no build step), deployed to GitHub Pages; serverless functions deploy to Netlify
(site `merkliste-app.netlify.app`).

## Architecture
- **netlify/functions/**: serverless functions
  - `blob.js` — GET/POST the `main` blob (`{ tickers, savedAt, version }`)
  - `check-alerts.js` — scheduled: Yahoo prices → status eval → ntfy push
  - `yahoo-quote.js` — browser-side quote proxy
  - `discovery-import.js` — proxies the discovery-export blob in
  - `lib/` — `status-logic.js` (pure alert engine, shared browser+serverless), `notify.js`
- **app.js / index.html / styles.css**: UI (no build step)

## Data Notes
- Tickers carry **no ISIN**. Match by symbol (plus `yahoo_symbol` / `twelvedata_symbol`).
- `user.entry_price_manual` is stored in **EUR** (the Trade-Republic display currency).

## Git Workflow

### Always promote finished work to `main` yourself — don't ask
The user has given standing permission to push to `main`. When a unit of work is
complete and verified, promote it without asking. Full sequence each time:
1. Commit on the feature branch (`claude/<...>`).
2. Push the feature branch.
3. Merge the feature branch into `main` (resolve conflicts; verify the merge didn't
   silently drop changes).
4. Push `main`.
5. Fast-forward the feature branch back to `main` so the next round starts clean.

## Development Gotchas
- **Netlify deploys cost credits — batch changes.** Every push that changes
  `netlify/functions/` or `netlify.toml` triggers a deploy. Diagnose locally first,
  batch backend changes into one commit.
- **No paid API plans — ever.** Only free tiers / public endpoints.
