#!/bin/bash
# Set up (first time only) and start JARVIS on Linux or macOS.
# JARVIS is the Node build (server.ts + the glass dashboard) on port 3000.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "JARVIS needs Node.js. Install the LTS version from nodejs.org"
  read -r -p "Press Enter to close. " _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing JARVIS's packages with npm install…"
  if ! npm install; then
    echo "npm install failed. Check that you are online, then run this file again."
    read -r -p "Press Enter to close. " _
    exit 1
  fi
fi

# Open the dashboard once the server has had a moment to come up.
( sleep 3; command -v open >/dev/null 2>&1 && open http://localhost:3000; command -v xdg-open >/dev/null 2>&1 && xdg-open http://localhost:3000 >/dev/null 2>&1 ) &

echo "Starting JARVIS on http://localhost:3000 …"
npm run dev || { read -r -p "Something went wrong. Press Enter to close. " _; }
