"""Async event stream with cursor resume."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Any, Protocol


class RpcCaller(Protocol):
    async def request(self, method: str, params: Any | None = None) -> Any: ...

    def on_notification(self, handler: Callable[[str, Any], None]) -> Callable[[], None]: ...


class EventStream:
    def __init__(self, session_id: str, rpc: RpcCaller) -> None:
        self.session_id = session_id
        self._rpc = rpc
        self.cursor = {"sessionId": session_id, "journalSequence": 0}

    async def subscribe(self) -> dict[str, Any]:
        result = await self._rpc.request(
            "events.subscribe",
            {"request": {"sessionIds": [self.session_id], "from": {self.session_id: self.cursor}}},
        )
        if isinstance(result, dict) and isinstance(result.get("cursor"), dict):
            self.cursor = result["cursor"]
        return result if isinstance(result, dict) else {}

    async def replay(self) -> list[dict[str, Any]]:
        result = await self._rpc.request(
            "events.replay",
            {"subscriptionId": "current", "after": self.cursor, "maxEvents": 64},
        )
        events = result.get("events") if isinstance(result, dict) else []
        if isinstance(result, dict) and isinstance(result.get("cursor"), dict):
            self.cursor = result["cursor"]
        return list(events) if isinstance(events, list) else []

    async def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        def on_note(method: str, params: Any) -> None:
            if method == "events.push" and isinstance(params, dict):
                for event in params.get("events", []):
                    if isinstance(event, dict):
                        queue.put_nowait(event)

        unsub = self._rpc.on_notification(on_note)
        try:
            await self.subscribe()
            for event in await self.replay():
                if isinstance(event, dict):
                    yield event
            while True:
                yield await queue.get()
        finally:
            unsub()
