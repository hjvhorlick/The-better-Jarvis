"""Phone pairing (V2-6): a phone on the home network can use the chat and read status.

Off unless the owner turns it on. Two switches are needed on purpose:
  * SUPPER_PAIRING=on    phone pairing is allowed
  * SUPPER_HOST=0.0.0.0  the app listens on the home network (the default is this computer only)

Pairing starts on this computer, by chat ("pair my phone"), and that asks first. A 6-digit code is
shown here for 5 minutes. It works once, and after 5 wrong tries it is cancelled. The phone types the
code on the pairing page and gets a device token in a cookie. Only a hash of the token is stored, in
runtime/paired_devices.json. A token lasts 30 days unless the owner forgets the phone.

A paired phone can use the web page, chat and read-only status. It cannot use My Hands (camera), voice
(microphone), files, the memory summary or self-repair. The owner can give one phone permission to
approve or deny actions ("let phone 1 approve"; the change itself asks on this computer). That phone
still cannot approve a request to pair a new phone. Those rules live in security.py and app.py.

Provenance: written for this project. Uses only the standard library.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import threading
import time
from pathlib import Path

CODE_SECONDS = 300          # the code is valid for five minutes
MAX_WRONG = 5               # after five wrong codes the code is cancelled
MAX_DEVICES = 10
TOKEN_SECONDS = 30 * 86400  # a paired phone is asked again after 30 days
COOKIE = "jarvis_device"
_LABEL = re.compile(r"[^A-Za-z0-9 _.\-]")


class PairingError(Exception):
    """A pairing step failed. The message is safe to show on the phone."""


def enabled() -> bool:
    """SUPPER_PAIRING=on (or 1, yes, true). Read each time, so a change needs only a restart."""
    return os.environ.get("SUPPER_PAIRING", "").strip().lower() in ("on", "1", "yes", "true")


def _h(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def lan_address() -> str | None:
    """This computer's address on the home network, or None. No packets are sent."""
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except OSError:
        return None
    finally:
        if s is not None:
            s.close()
    return None if not ip or ip.startswith("127.") or ip == "0.0.0.0" else ip


class PairingStore:
    def __init__(self, path: Path, clock=time.time) -> None:
        self._path = Path(path)
        self._clock = clock
        self._lock = threading.Lock()
        self._code: dict | None = None
        self._devices: list[dict] = self._load()

    # ----- storage -----

    def _load(self) -> list[dict]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        now = self._clock()
        devices = data.get("devices") if isinstance(data, dict) else None
        out = []
        for d in devices or []:
            if isinstance(d, dict) and d.get("token_hash") and float(d.get("expires", 0)) > now:
                out.append(d)
        return out

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(self._path.name + ".tmp")
        tmp.write_text(json.dumps({"devices": self._devices}, indent=2), encoding="utf-8")
        os.replace(tmp, self._path)

    # ----- pairing -----

    def start_code(self) -> dict:
        """A new code. It replaces any code not yet used."""
        with self._lock:
            code = f"{secrets.randbelow(1_000_000):06d}"
            self._code = {"hash": _h(code), "expires": self._clock() + CODE_SECONDS, "wrong": 0}
            return {"code": code, "seconds": CODE_SECONDS}

    def claim(self, code: str, label: str | None = None) -> tuple[str, dict]:
        """Exchange a code for a device token. The code works once."""
        code = (code or "").strip()
        now = self._clock()
        with self._lock:
            c = self._code
            if c is None or now > c["expires"]:
                self._code = None
                raise PairingError("The code has expired or was not started. Ask for a new code on the computer.")
            if not re.fullmatch(r"\d{6}", code) or not hmac.compare_digest(_h(code), c["hash"]):
                c["wrong"] += 1
                if c["wrong"] >= MAX_WRONG:
                    self._code = None
                    raise PairingError("Too many wrong codes. Ask for a new code on the computer.")
                raise PairingError("That code is not right.")
            if len(self._devices) >= MAX_DEVICES:
                raise PairingError("This computer already has the most phones allowed. Forget one first.")
            self._code = None                       # one use
            token = secrets.token_urlsafe(32)
            name = _clean_label(label) or f"Phone {len(self._devices) + 1}"
            device = {
                "id": secrets.token_hex(4),
                "label": name,
                "token_hash": _h(token),
                "created": int(now),
                "last_seen": int(now),
                "expires": int(now + TOKEN_SECONDS),
                "may_approve": False,               # the owner must allow it, on this computer
            }
            self._devices.append(device)
            self._save()
            return token, _public(device)

    def verify(self, token: str | None) -> bool:
        """True for a live device token. Records when the phone was last seen (saved at most once a minute)."""
        return self.device(token) is not None

    def device(self, token: str | None) -> dict | None:
        """The phone that owns this live token (its public details, including may_approve), or None."""
        if not token or len(token) > 200:
            return None
        h = _h(token)
        now = self._clock()
        with self._lock:
            for d in self._devices:
                if hmac.compare_digest(d["token_hash"], h):
                    if now > float(d["expires"]):
                        return None
                    if now - float(d.get("last_seen", 0)) > 60:
                        d["last_seen"] = int(now)
                        self._save()
                    return _public(d)
        return None

    def set_approve(self, number: int, allowed: bool) -> dict | None:
        """Give (or take away) permission to approve actions for the phone with this number."""
        with self._lock:
            if not (1 <= number <= len(self._devices)):
                return None
            self._devices[number - 1]["may_approve"] = bool(allowed)
            self._save()
            return _public(self._devices[number - 1])

    def devices(self) -> list[dict]:
        """Paired phones in the order they were paired, numbered from 1 (no tokens or hashes)."""
        with self._lock:
            return [{"number": i + 1, **_public(d)} for i, d in enumerate(self._devices)]

    def revoke(self, number: int) -> dict | None:
        """Forget the phone with this number (from devices()). Returns it, or None."""
        with self._lock:
            if not (1 <= number <= len(self._devices)):
                return None
            gone = self._devices.pop(number - 1)
            self._save()
            return _public(gone)


def _public(device: dict) -> dict:
    return {"id": device["id"], "label": device["label"], "created": device["created"],
            "last_seen": device.get("last_seen", device["created"]), "expires": device["expires"],
            "may_approve": bool(device.get("may_approve", False))}


def _clean_label(label: str | None) -> str:
    if not label:
        return ""
    return _LABEL.sub("", str(label))[:40].strip()
