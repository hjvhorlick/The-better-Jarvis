"""Access guard: this computer by default; paired phones only when the owner has allowed it.

On this computer (Host header names this machine), every request is allowed, as before. Two checks
apply to every request:

  * Host header must name the local machine (blocks DNS-rebinding attacks,
    where a hostile domain is pointed at 127.0.0.1).
  * If an Origin header is sent, it must be a local origin (blocks cross-site
    requests from ordinary web pages).

A paired phone (V2-6, see pairing.py) reaches the app by its home-network address, which is a
private IP literal. That is allowed only when SUPPER_PAIRING=on and the request is on the list
below. Everything else from the network is refused. The rules:

  * no token: the pairing page (GET /pair) and the code exchange (POST /api/pairing/claim) only;
  * with a device cookie: the web page, chat, the event stream and read-only status;
  * never from a phone: approving or denying actions, My Hands (camera and its stream), voice
    (microphone), files, memory summary and self-repair.

Origin rule for phones: no Origin header, or an Origin that names the same address.
"""
from __future__ import annotations

import ipaddress
import os
import re
from http.cookies import SimpleCookie
from urllib.parse import urlparse

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from . import pairing

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}
_LOCAL_ORIGIN = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$")

PAIR_PAGE = "/pair"
CLAIM_PATH = "/api/pairing/claim"
# What a paired phone may call. Everything not listed is refused.
PHONE_GET = {"/api/health", "/api/status", "/api/workspaces", "/api/confirmations",
             "/api/diagnostics", "/api/voice/status", "/api/myhands/status"}
PHONE_POST = {"/api/chat"}
PHONE_WS = {"/ws/events"}
# Approving or denying one pending confirmation. Only a phone the owner allowed may do this, and the
# route refuses a request to pair a new phone (see app.py).
PHONE_CONFIRM = re.compile(r"^/api/confirmations/[^/]{1,64}$")


def extra_hosts() -> frozenset[str]:
    """Extra host names the owner has chosen to allow, from SUPPER_EXTRA_HOSTS (comma separated).

    Off by default. Used for a hosted preview, where the page is reached under a different name.
    Each name is matched exactly. Leave it unset on the owner's own computer.
    """
    raw = os.environ.get("SUPPER_EXTRA_HOSTS", "")
    return frozenset(h.strip().lower() for h in raw.split(",") if h.strip())


def _host_name(host_header: str) -> str:
    host = (host_header or "").strip().lower()
    if host.startswith("["):                      # [::1]:8765
        return host[1:host.index("]")] if "]" in host else ""
    if host.count(":") > 1:                       # bare IPv6, e.g. ::1
        return host
    return host.split(":")[0]                     # 127.0.0.1:8765, localhost


def host_is_local(host_header: str, extra: frozenset[str] = frozenset()) -> bool:
    host = (host_header or "").strip().lower()
    if host.startswith("["):
        name = host.split("]")[0] + "]"
    elif host.count(":") > 1:
        name = host
    else:
        name = host.split(":")[0]
    return name in _LOCAL_HOSTS or name in extra


def private_address(host_header: str) -> bool:
    """True when the Host header is a private network address written as a number (not a name)."""
    try:
        ip = ipaddress.ip_address(_host_name(host_header))
    except ValueError:
        return False                              # a name, e.g. evil.example: never a phone address
    return ip.is_private and not ip.is_loopback and not ip.is_unspecified


def origin_is_local(origin: str, extra: frozenset[str] = frozenset()) -> bool:
    origin = (origin or "").strip()
    if _LOCAL_ORIGIN.match(origin):
        return True
    if not extra:
        return False
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    return parsed.scheme == "https" and (parsed.hostname or "") in extra


def origin_is_same_address(origin: str, host_header: str) -> bool:
    """A phone's Origin must name the same address the phone used (plain http, no other site)."""
    if origin is None:
        return True
    try:
        parsed = urlparse(origin.strip())
    except ValueError:
        return False
    return parsed.scheme == "http" and (parsed.hostname or "") == _host_name(host_header)


def phone_may_call(kind: str, method: str, path: str, has_device: bool, may_approve: bool = False) -> bool:
    """The phone rules above. `kind` is "http" or "websocket". `may_approve` is the owner's permission."""
    if kind == "websocket":
        return has_device and path in PHONE_WS
    if method == "GET" and path == PAIR_PAGE:
        return True
    if method == "POST" and path == CLAIM_PATH:
        return True                               # the code is the check; wrong tries are counted
    if not has_device:
        return False
    if method == "POST" and PHONE_CONFIRM.match(path):
        return may_approve
    if path.startswith("/api/") or path.startswith("/ws/"):
        if method == "GET":
            return path in PHONE_GET
        if method == "POST":
            return path in PHONE_POST
        return False
    return method == "GET"                        # the web page and its files


def _device_token(headers: dict) -> str | None:
    raw = headers.get("cookie")
    if not raw:
        return None
    try:
        jar = SimpleCookie()
        jar.load(raw)
    except Exception:
        return None
    morsel = jar.get(pairing.COOKIE)
    return morsel.value if morsel is not None else None


class LocalOnlyGuard:
    """Pure ASGI middleware, so it also protects static files and websockets."""

    def __init__(self, app: ASGIApp, extra: frozenset[str] | None = None, pairing_store=None) -> None:
        self.app = app
        self.extra = extra_hosts() if extra is None else frozenset(extra)
        self.pairing = pairing_store

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1")
                   for k, v in scope.get("headers", [])}
        host = headers.get("host", "")
        origin = headers.get("origin")
        if host_is_local(host, self.extra):
            if origin is not None and not origin_is_local(origin, self.extra):
                await self._deny(scope, send, "origin not allowed")
                return
            await self.app(scope, receive, send)
            return
        if pairing.enabled() and self.pairing is not None and private_address(host):
            if not origin_is_same_address(origin, host):
                await self._deny(scope, send, "origin not allowed")
                return
            device = self.pairing.device(_device_token(headers))
            has_device = device is not None
            may_approve = bool(device and device.get("may_approve"))
            method = scope.get("method", "GET") if scope["type"] == "http" else ""
            if not phone_may_call(scope["type"], method, scope.get("path", ""), has_device, may_approve):
                reason = ("sign in from a paired phone first" if not has_device
                          else "not allowed from a phone; use this computer")
                await self._deny(scope, send, reason)
                return
            if device is not None:
                scope.setdefault("state", {})["device"] = device   # the route checks the rest
            await self.app(scope, receive, send)
            return
        await self._deny(scope, send, "host not allowed")

    @staticmethod
    async def _deny(scope: Scope, send: Send, reason: str) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        response = JSONResponse({"detail": reason}, status_code=403)
        await response(scope, _no_receive, send)


async def _no_receive():  # pragma: no cover - never awaited for a plain response
    return {"type": "http.disconnect"}
