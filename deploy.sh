#!/bin/bash
# deploy.sh — Merkliste auf Netlify deployen
# Site bereits erstellt: merkliste-app.netlify.app
# Einmalig ausführen: bash deploy.sh

set -e

SITE_ID="e4c411dd-b22c-485a-9fb1-363e03181aaa"

echo "=== Merkliste Deploy → merkliste-app.netlify.app ==="
echo ""

# Netlify CLI installieren falls nicht vorhanden
if ! command -v netlify &> /dev/null; then
    echo "[1/3] Netlify CLI installieren..."
    npm install -g netlify-cli
else
    echo "[1/3] Netlify CLI: $(netlify --version)"
fi

# Login
echo ""
echo "[2/3] Netlify Login..."
netlify login

# Deploy mit Functions
echo ""
echo "[3/3] Deploy zu Site $SITE_ID..."
netlify deploy --prod \
  --site "$SITE_ID" \
  --dir . \
  --functions netlify/functions \
  --message "Merkliste deploy"

echo ""
echo "=== Fertig! ==="
echo "URL: https://merkliste-app.netlify.app"
