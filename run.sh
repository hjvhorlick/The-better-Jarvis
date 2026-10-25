#!/bin/bash
xhost +SI:localuser:$USER >/dev/null 2>&1
cd "/home/vincent/Jarvis"
source .venv/bin/activate
python main.py
