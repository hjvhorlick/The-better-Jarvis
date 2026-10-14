#!/usr/bin/env bash
# Compatibility alias: all supported launchers start the Node dashboard.
# The former script hard-coded /home/vincent/Jarvis and ran main.py, which
# served a different dashboard without the local voice and My Hands APIs.
exec "$(dirname "$0")/start_jarvis.sh" "$@"
