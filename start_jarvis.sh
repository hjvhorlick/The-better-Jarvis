#!/bin/bash
# Set up (first time only) and start JARVIS on Linux or macOS.
cd "$(dirname "$0")" || exit 1
PY=""
for v in python3.11 python3.12 python3.10 python3; do
  if command -v "$v" >/dev/null 2>&1; then PY="$v"; break; fi
done
if [ -z "$PY" ]; then
  echo "JARVIS needs Python 3.10, 3.11 or 3.12. Install it first (python.org on macOS; your package manager on Linux)."
  read -r -p "Press Enter to close. " _
  exit 1
fi
"$PY" tools/start_jarvis.py "$@" || { read -r -p "Something went wrong. Press Enter to close. " _; }
