"""Session handle over App Protocol."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from .approvals import ApprovalDecision
from .stream import EventStream


class RpcCaller(Protocol):
    async def request(self, method: str, params: Any | None = None) -> Any: ...

    async def request_idempotent(
        self,
        method: str,
        *,
        idempotency_key: str,
        params: dict[str, Any],
        send_params: dict[str, Any] | None = None,
    ) -> Any: ...

    @property
    def client_id(self) -> str: ...

    def on_notification(self, handler: Callable[[str, Any], None]) -> Callable[[], None]: ...


@dataclass(frozen=True, slots=True)
class TurnHandle:
    turn_id: str
    command_id: str
    idempotency_key: str
    receipt: dict[str, Any]


class Session:
    def __init__(
        self,
        session_id: str,
        rpc: RpcCaller,
        *,
        workspace_identity_digest: str | None = None,
    ) -> None:
        self.id = session_id
        self.workspace_identity_digest = workspace_identity_digest
        self._rpc = rpc
        self.last_turn: TurnHandle | None = None
        self.last_submit_envelope: dict[str, Any] | None = None
        self._approval: Callable[[dict[str, Any]], ApprovalDecision] | None = None

    def on_approval(self, handler: Callable[[dict[str, Any]], ApprovalDecision]) -> None:
        self._approval = handler

    async def attach(self, *, mode: str = "controller") -> Any:
        params: dict[str, Any] = {"sessionId": self.id, "mode": mode}
        if self.workspace_identity_digest is not None:
            params["workspaceIdentityDigest"] = self.workspace_identity_digest
        return await self._rpc.request("session.attach", params)

    async def detach(self) -> Any:
        params: dict[str, Any] = {"sessionId": self.id}
        if self.workspace_identity_digest is not None:
            params["workspaceIdentityDigest"] = self.workspace_identity_digest
        return await self._rpc.request("session.detach", params)

    async def submit(self, prompt: str, *, idempotency_key: str | None = None) -> TurnHandle:
        key = idempotency_key or f"idem_{uuid.uuid4().hex}"
        payload = {"prompt": prompt}
        previous = self.last_submit_envelope
        if (
            previous is not None
            and previous.get("idempotencyKey") == key
            and previous.get("payload") == payload
        ):
            envelope = previous
        else:
            envelope = {
                "schemaVersion": "1.0",
                "commandId": f"cmd_{uuid.uuid4().hex}",
                "idempotencyKey": key,
                "correlationId": f"corr_{uuid.uuid4().hex}",
                "clientId": self._rpc.client_id,
                "sessionId": self.id,
                "issuedAt": _now(),
                "payload": payload,
            }
            if self.workspace_identity_digest is not None:
                envelope["workspaceIdentityDigest"] = self.workspace_identity_digest
            self.last_submit_envelope = envelope
        params = {"command": envelope}
        # Idempotency compares the durable command payload, not volatile ids.
        receipt = await self._rpc.request_idempotent(
            "turn.submit",
            idempotency_key=key,
            params={"payload": payload, "sessionId": self.id},
            send_params=params,
        )
        if not isinstance(receipt, dict):
            raise TypeError("turn.submit must return an object")
        turn_id = ""
        result = receipt.get("result")
        if isinstance(result, dict) and isinstance(result.get("turnId"), str):
            turn_id = result["turnId"]
        elif isinstance(receipt.get("turnId"), str):
            turn_id = receipt["turnId"]
        handle = TurnHandle(
            turn_id=turn_id,
            command_id=str(envelope["commandId"]),
            idempotency_key=key,
            receipt=receipt,
        )
        self.last_turn = handle
        return handle

    async def submit_turn(self, prompt: str, *, idempotency_key: str | None = None) -> dict[str, Any]:
        handle = await self.submit(prompt, idempotency_key=idempotency_key)
        return handle.receipt

    async def run(self, prompt: str) -> TurnHandle:
        await self.attach()
        return await self.submit(prompt)

    async def wait(self, turn_id: str | None = None) -> dict[str, Any]:
        target = turn_id or (self.last_turn.turn_id if self.last_turn else "")
        result = await self._rpc.request("turn.wait", {"sessionId": self.id, "turnId": target})
        return result if isinstance(result, dict) else {"result": result}

    async def cancel(self, turn_id: str | None = None) -> dict[str, Any]:
        target = turn_id or (self.last_turn.turn_id if self.last_turn else "")
        result = await self._rpc.request("turn.cancel", {"sessionId": self.id, "turnId": target})
        return result if isinstance(result, dict) else {"result": result}

    def events(self) -> EventStream:
        return EventStream(self.id, self._rpc)


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
