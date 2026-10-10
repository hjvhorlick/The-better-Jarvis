#!/bin/bash
# macOS: double-click this file in Finder. It runs the same starter as start_jarvis.sh.
cd "$(dirname "$0")" || exit 1
exec ./start_jarvis.sh "$@"
