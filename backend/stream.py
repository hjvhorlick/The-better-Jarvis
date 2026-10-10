"""Generic event stream: GET /ws/events?since=N (WebSocket, local-only guard applies).

Sends every event from the shared bus after N, as {"seq": n, "event": {...}}.
Clients filter by event["source"]. Replay starts from `since`; if that is older than
the retained window, the client gets everything still held and can see the gap via
the `oldest_seq` value in /api/diagnostics.
"""
from __future__ import annotations

import asyncio

from fastapi import FastAPI, Query, WebSocket

from .events import EventBus


def register(app: FastAPI, bus: EventBus) -> None:
    @app.websocket("/ws/events")
    async def ws_events(ws: WebSocket, since: int = Query(default=0, ge=0)) -> None:
        await ws.accept()
        last = since
        try:
            while True:
                for seq, event in bus.since(last):
                    await ws.send_json({"seq": seq, "event": event})
                    last = seq
                await asyncio.sleep(0.03)
        except Exception:
            return                                       # client went away
