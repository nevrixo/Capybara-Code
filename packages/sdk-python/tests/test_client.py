"""Mock App Protocol coverage: initialize, turn.submit, reconnect idempotency."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from capybara_code.client import CapybaraClient, MockTransport
from capybara_code.errors import ProtocolError


def mock_handler_factory(receipts: dict[str, Any]):
    initialized = {"value": False}

    async def handler(message: dict[str, Any]) -> dict[str, Any]:
        request_id = message["id"]
        method = message["method"]
        if method == "server.initialize":
            initialized["value"] = True
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": "1.0",
                    "serverVersion": "0.1.0",
                    "daemonId": "dmn_mock",
                    "connectionId": "conn_mock",
                    "capabilities": {"eventStreaming": True},
                    "limits": {
                        "maxRequestBytes": 1048576,
                        "maxResponseBytes": 6291456,
                        "maxSubscriptionsPerClient": 64,
                        "maxSessionsPerSubscription": 1,
                    },
                },
            }
        if not initialized["value"]:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32000,
                    "message": "not initialized",
                    "data": {
                        "code": "APP_CONNECTION_REQUIRED",
                        "category": "protocol",
                        "retryable": True,
                    },
                },
            }
        if method == "turn.submit":
            params = message.get("params") or {}
            command = params.get("command") or {}
            key = command.get("idempotencyKey")
            if key in receipts:
                return {"jsonrpc": "2.0", "id": request_id, "result": receipts[key]}
            receipt = {
                "schemaVersion": "1.0",
                "receiptId": f"rcpt_{key}",
                "commandId": command.get("commandId"),
                "idempotencyKey": key,
                "status": "accepted",
                "startedAt": command.get("issuedAt"),
                "evidenceIds": [],
                "turnId": f"turn_{key}",
            }
            receipts[key] = receipt
            return {"jsonrpc": "2.0", "id": request_id, "result": receipt}
        if method == "session.attach":
            return {"jsonrpc": "2.0", "id": request_id, "result": {"ok": True}}
        return {"jsonrpc": "2.0", "id": request_id, "result": {"ok": True, "method": method}}

    return handler


def test_initialize_and_turn_submit() -> None:
    async def body() -> None:
        receipts: dict[str, Any] = {}
        client = await CapybaraClient.connect(
            create_transport=lambda: MockTransport(mock_handler_factory(receipts)),
            client={"id": "client_test"},
        )
        assert client.daemon_id == "dmn_mock"
        assert client.connection_id == "conn_mock"

        session = client.session("ses_1", workspace_identity_digest="ws_1")
        result = await session.submit_turn("fix the parser", idempotency_key="idem_fixed")
        assert result["idempotencyKey"] == "idem_fixed"
        assert result["status"] == "accepted"
        assert len(receipts) == 1
        await client.close()

    asyncio.run(body())


def test_reconnect_idempotency_does_not_duplicate_submit() -> None:
    async def body() -> None:
        receipts: dict[str, Any] = {}
        client = await CapybaraClient.connect(
            create_transport=lambda: MockTransport(mock_handler_factory(receipts)),
            client={"id": "client_re"},
        )
        session = client.session("ses_2", workspace_identity_digest="ws_2")
        first = await session.submit_turn("again", idempotency_key="idem_same")
        second = await session.submit_turn("again", idempotency_key="idem_same")
        assert first == second
        assert len(receipts) == 1

        welcome = await client.reconnect()
        assert welcome["daemonId"] == "dmn_mock"
        third = await session.submit_turn("again", idempotency_key="idem_same")
        assert third == first
        assert len(receipts) == 1

        with pytest.raises(ProtocolError) as exc:
            await client.request_idempotent(
                "turn.submit",
                idempotency_key="idem_same",
                params={"command": {"payload": {"prompt": "different"}}},
            )
        assert exc.value.code == "IDEMPOTENCY_KEY_REUSED"
        await client.close()

    asyncio.run(body())
