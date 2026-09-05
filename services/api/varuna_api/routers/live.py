"""``WS /v1/live``: relays bus events as :class:`LiveEvent` JSON (CLAUDE.md 11.11).

Protocol:

- on connect the server sends ``{"topic": "hello", "ts", "payload": {version, mode, city,
  bundle, topics, heartbeat_s}}``;
- every bus event whose topic is in ``WS_TOPICS`` arrives as a ``LiveEvent`` object;
- the client may send ``{"type": "ping"}`` and gets ``{"type": "pong", "ts"}``;
- the server sends ``{"topic": "heartbeat", "ts", "payload": {"uptime_s"}}`` every 15 s.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime
from typing import Any

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from varuna_cycle.bus import Subscription
from varuna_schemas.constants import IST, WS_TOPICS

from varuna_api.state import AppState

router = APIRouter(tags=["live"])
log = structlog.get_logger("varuna.api.live")


def _now() -> str:
    return datetime.now(IST).isoformat()


def _state(ws: WebSocket) -> AppState:
    return ws.app.state.varuna


async def _reader(ws: WebSocket) -> None:
    """Answer pings; any other client message is ignored (the socket is server-to-client)."""
    while True:
        message: Any = await ws.receive_json()
        if isinstance(message, dict) and message.get("type") == "ping":
            await ws.send_json({"type": "pong", "ts": _now(), "echo": message.get("id")})


async def _relay(ws: WebSocket, sub: Subscription) -> None:
    async for event in sub:
        if event.is_ws_topic:
            await ws.send_text(event.model_dump_json())


async def _heartbeat(ws: WebSocket, state: AppState) -> None:
    while True:
        await asyncio.sleep(state.ws_heartbeat_s)
        await ws.send_json(
            {"topic": "heartbeat", "ts": _now(), "payload": {"uptime_s": round(state.uptime_s, 1)}}
        )


@router.websocket("/v1/live")
async def live(ws: WebSocket) -> None:
    state = _state(ws)
    await ws.accept()
    sub = state.bus.subscribe(list(WS_TOPICS))
    settings = state.settings
    last = state.latest_run()
    await ws.send_json(
        {
            "topic": "hello",
            "ts": _now(),
            "run_id": last.run_id if last else None,
            "payload": {
                "version": state.version,
                "mode": settings.varuna_mode,
                "city": settings.varuna_city,
                "bundle": settings.varuna_bundle if settings.is_replay else None,
                "topics": list(WS_TOPICS),
                "heartbeat_s": state.ws_heartbeat_s,
                "last_run_id": last.run_id if last else None,
            },
        }
    )
    tasks = [
        asyncio.create_task(_reader(ws), name="ws-reader"),
        asyncio.create_task(_relay(ws, sub), name="ws-relay"),
        asyncio.create_task(_heartbeat(ws, state), name="ws-heartbeat"),
    ]
    try:
        done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(exc, WebSocketDisconnect | RuntimeError):
                log.warning("live.task_failed", task=task.get_name(), error=repr(exc))
    except WebSocketDisconnect:
        pass
    finally:
        sub.close()
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(BaseException):
                await task
        log.debug("live.closed", dropped=sub.dropped)


__all__ = ["router"]
