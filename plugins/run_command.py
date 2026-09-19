"""
run_command — gives JARVIS real hands on this Linux machine.

Two tiers:
  • SAFE commands (read-only: ls, cat, grep, df, ps, git status, pip list …) run immediately.
  • RISKY commands (delete, sudo, package installs, writes outside ~/Jarvis, kill, chmod …)
    are held until the user says "confirm" — JARVIS must ask out loud first.
Every command and its result is appended to ~/Jarvis/memory/command_log.txt.
"""
from __future__ import annotations
import os, re, shlex, subprocess, time
from pathlib import Path

_HOME = Path.home()
_LOG  = _HOME / "Jarvis" / "memory" / "command_log.txt"
_PENDING: dict = {}          # {"cmd": str, "ts": float}
_PENDING_TTL = 120           # seconds the user has to say "confirm"

_RISKY = re.compile(
    r"(^|\s|;|&&|\|\|)(sudo|su|rm|rmdir|shred|dd|mkfs|fdisk|parted|kill|killall|pkill|"
    r"reboot|shutdown|poweroff|systemctl|chmod|chown|chattr|mv|apt|apt-get|dpkg|snap|flatpak|"
    r"pip3?\s+(install|uninstall)|npm\s+(install|i|uninstall)|curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh|"
    r"crontab|passwd|useradd|userdel|iptables|ufw|truncate|>\s*/(etc|usr|boot|bin|sbin|lib))(\s|$)")

def _risky(cmd: str) -> bool:
    if _RISKY.search(cmd):
        return True
    # writing files with > is fine inside ~/Jarvis or /tmp, risky elsewhere
    for m in re.finditer(r">{1,2}\s*(\S+)", cmd):
        target = m.group(1).strip("'\"")
        if target.startswith("&") or target == "/dev/null":
            continue
        target = os.path.abspath(os.path.expanduser(target.replace("$HOME", str(_HOME))))
        ok_roots = (str(_HOME / "Jarvis"), "/tmp")
        if not any(target.startswith(r) for r in ok_roots):
            return True
    return False

def _log(cmd: str, out: str, code: int | str):
    try:
        _LOG.parent.mkdir(parents=True, exist_ok=True)
        with _LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] $ {cmd}\n  exit={code}\n  {out[:600].rstrip()}\n\n")
    except Exception:
        pass

def _run(cmd: str, timeout: int) -> str:
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout,
                           cwd=str(_HOME), env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})
        out = (r.stdout or "") + (("\n[stderr] " + r.stderr) if r.stderr.strip() else "")
        out = out.strip() or "(no output)"
        _log(cmd, out, r.returncode)
        if len(out) > 3500:
            out = out[:3500] + f"\n…[truncated, {len(out)} chars total]"
        return f"exit {r.returncode}\n{out}"
    except subprocess.TimeoutExpired:
        _log(cmd, "TIMEOUT", "timeout")
        return f"Timed out after {timeout}s. If it is a long job, run it in the background with '&' or raise the timeout."
    except Exception as e:
        _log(cmd, str(e), "error")
        return f"Failed to run: {e}"

PLUGIN = {
    "name": "run_command",
    "description": (
        "Run a Linux shell command on the user's own laptop (Ubuntu/Zorin) and return its output. "
        "USE THIS whenever the user asks about or wants to change anything on the computer that no "
        "other tool covers: list/find/read files anywhere, disk space, memory, CPU, processes, "
        "network, installed programs, versions, logs, git, python/pip, timers, system info, "
        "writing scripts, installing software, fixing errors. Prefer this over guessing or saying "
        "you cannot. Read-only commands run at once. Destructive ones (delete, sudo, install, kill, "
        "chmod, mv, writes outside ~/Jarvis) are HELD: tell the user exactly what will run, ask for "
        "confirmation, and when they say 'confirm' call again with action='confirm'. "
        "action='cancel' drops a held command. Not for opening GUI apps (use open_app) or "
        "clicking/typing (use computer_control)."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "command": {"type": "STRING", "description": "the exact bash command line"},
            "action":  {"type": "STRING", "description": "run (default) | confirm | cancel"},
            "timeout": {"type": "INTEGER", "description": "seconds, default 25, max 300"},
        },
        "required": [],
    },
}

def run(parameters: dict, player=None, session_memory=None) -> str:
    global _PENDING
    action  = str(parameters.get("action", "run") or "run").lower()
    cmd     = str(parameters.get("command", "") or "").strip()
    timeout = max(1, min(int(parameters.get("timeout") or 25), 300))

    def log(t):
        if player:
            try: player.write_log(f"SHELL: {t}")
            except Exception: pass

    if action == "cancel":
        _PENDING = {}
        return "Cancelled. Nothing was run."

    if action == "confirm":
        if not _PENDING or time.time() - _PENDING["ts"] > _PENDING_TTL:
            _PENDING = {}
            return "There is no command waiting for confirmation (it may have expired). Ask me again."
        cmd = _PENDING["cmd"]; _PENDING = {}
        log(f"$ {cmd}  (confirmed)")
        return _run(cmd, timeout)

    if not cmd:
        return "No command given."

    if _risky(cmd):
        _PENDING = {"cmd": cmd, "ts": time.time()}
        log(f"HELD: {cmd}")
        return (f"[NEEDS CONFIRMATION] This command can change or remove things: `{cmd}`. "
                f"Tell the user exactly what it does in one sentence and ask them to say 'confirm'. "
                f"Do not claim it has run.")

    log(f"$ {cmd}")
    return _run(cmd, timeout)
