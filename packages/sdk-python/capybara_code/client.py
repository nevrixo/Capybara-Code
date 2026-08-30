"""Asyncio App Protocol JSON-RPC client (protocol version 1.0)."""

from __future__ import annotations

import asyncio
import json
import os
import struct
import sys
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

from .errors import ProtocolError, RpcError
from .session import Session

PROTOCOL_VERSION = "1.0"
MAX_FRAME_BYTES = 8 * 1024 * 1024


class JsonRpcTransport(Protocol):
    async def send(self, message: dict[str, Any]) -> None: ...
    def subscribe(self, handler: Callable[[dict[str, Any]], None]) -> Callable[[], None]: ...
    async def close(self) -> None: ...


class MockTransport:
    """In-memory transport for tests and embedded hosts."""

    def __init__(
        self,
        handler: Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None] | dict[str, Any] | None],
    ) -> None:
        self._handler = handler
        self._listeners: list[Callable[[dict[str, Any]], None]] = []

    async def send(self, message: dict[str, Any]) -> None:
        result = self._handler(message)
        if asyncio.iscoroutine(result):
            result = await result
        if result is not None:
            for listener in list(self._listeners):
                listener(result)

    def subscribe(self, handler: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        self._listeners.append(handler)

        def unsubscribe() -> None:
            if handler in self._listeners:
                self._listeners.remove(handler)

        return unsubscribe

    async def close(self) -> None:
        self._listeners.clear()


class StreamTransport:
    """Length-prefixed or NDJSON frames over asyncio streams (UDS / stdio / pipes)."""

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        *,
        mode: str = "length-prefixed",
        max_frame_bytes: int = MAX_FRAME_BYTES,
    ) -> None:
        if mode not in {"length-prefixed", "ndjson"}:
            raise ProtocolError("unsupported frame mode", code="APP_TRANSPORT_INVALID")
        self._reader = reader
        self._writer = writer
        self._mode = mode
        self._max_frame_bytes = max_frame_bytes
        self._listeners: list[Callable[[dict[str, Any]], None]] = []
        self._task: asyncio.Task[None] | None = None
        self._closed = False

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._read_loop(), name="capy-stream-transport")

    async def send(self, message: dict[str, Any]) -> None:
        if self._closed:
            raise ProtocolError("transport closed", code="TRANSPORT_CLOSED")
        raw = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(raw) > self._max_frame_bytes:
            raise ProtocolError("outbound frame too large", code="FRAME_TOO_LARGE")
        if self._mode == "ndjson":
            self._writer.write(raw + b"\n")
        else:
            self._writer.write(struct.pack(">I", len(raw)) + raw)
        await self._writer.drain()

    def subscribe(self, handler: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        self._listeners.append(handler)

        def unsubscribe() -> None:
            if handler in self._listeners:
                self._listeners.remove(handler)

        return unsubscribe

    async def close(self) -> None:
        self._closed = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self._writer.close()
        try:
            await self._writer.wait_closed()
        except Exception:
            pass
        self._listeners.clear()

    async def _read_loop(self) -> None:
        try:
            while not self._closed:
                message = await self._read_one()
                if message is None:
                    return
                for listener in list(self._listeners):
                    listener(message)
        except asyncio.CancelledError:
            raise
        except Exception:
            return

    async def _read_one(self) -> dict[str, Any] | None:
        if self._mode == "ndjson":
            line = await self._reader.readline()
            if not line:
                return None
            if len(line) > self._max_frame_bytes:
                raise ProtocolError("ndjson frame too large", code="FRAME_TOO_LARGE")
            return json.loads(line.decode("utf-8"))
        header = await self._reader.readexactly(4)
        length = struct.unpack(">I", header)[0]
        if length > self._max_frame_bytes:
            raise ProtocolError("frame too large", code="FRAME_TOO_LARGE")
        body = await self._reader.readexactly(length)
        return json.loads(body.decode("utf-8"))


class CapybaraClient:
    def __init__(self, transport: JsonRpcTransport, *, client_id: str | None = None) -> None:
        self._transport = transport
        self._client_id = client_id or f"py_{uuid.uuid4().hex}"
        self._pending: dict[str | int, asyncio.Future[Any]] = {}
        self._notify: list[Callable[[str, Any], None]] = []
        self._unsubscribe = transport.subscribe(self._on_message)
        self.initialize_result: dict[str, Any] | None = None
        self._idempotency: dict[str, dict[str, Any]] = {}

    @property
    def client_id(self) -> str:
        return self._client_id

    @property
    def connection_id(self) -> str | None:
        if self.initialize_result is None:
            return None
        value = self.initialize_result.get("connectionId")
        return value if isinstance(value, str) else None

    @property
    def daemon_id(self) -> str | None:
        if self.initialize_result is None:
            return None
        value = self.initialize_result.get("daemonId")
        return value if isinstance(value, str) else None

    @classmethod
    async def connect(
        cls,
        *,
        path: str | None = None,
        stdio: tuple[asyncio.StreamReader, asyncio.StreamWriter] | None = None,
        create_transport: Callable[[], JsonRpcTransport] | None = None,
        client: dict[str, Any] | None = None,
        mode: str = "length-prefixed",
    ) -> CapybaraClient:
        if create_transport is not None:
            transport = create_transport()
        elif stdio is not None:
            stream = StreamTransport(stdio[0], stdio[1], mode=mode)
            stream.start()
            transport = stream
        else:
            socket_path = path or default_socket_path()
            reader, writer = await open_local_connection(socket_path)
            stream = StreamTransport(reader, writer, mode=mode)
            stream.start()
            transport = stream
        instance = cls(transport, client_id=(client or {}).get("id"))
        await instance.initialize(client or {})
        return instance

    async def __aenter__(self) -> CapybaraClient:
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        await self.close()

    async def initialize(self, client: dict[str, Any] | None = None) -> dict[str, Any]:
        identity = client or {}
        result = await self.request(
            "server.initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "client": {
                    "id": identity.get("id", self._client_id),
                    "name": identity.get("name", "capybara-python"),
                    "version": identity.get("version", "0.1.0"),
                    "kind": identity.get("kind", "sdk"),
                },
                "capabilities": {
                    "eventStreaming": True,
                    "eventAck": True,
                    "approvals": True,
                    "interactivePrompts": True,
                    "artifactStreaming": True,
                    "richDiff": True,
                    "taskTree": True,
                    "planReview": True,
                },
            },
        )
        if not isinstance(result, dict):
            raise ProtocolError("server.initialize returned a non-object")
        self.initialize_result = result
        return result

    async def reconnect(self) -> dict[str, Any]:
        """Re-handshake. Non-idempotent commands are never auto-retried."""
        return await self.initialize()

    def session(self, session_id: str, *, workspace_identity_digest: str | None = None) -> Session:
        return Session(session_id, self, workspace_identity_digest=workspace_identity_digest)

    async def request(self, method: str, params: Any | None = None) -> Any:
        request_id = uuid.uuid4().hex
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        await self._transport.send(message)
        return await future

    async def request_idempotent(
        self,
        method: str,
        *,
        idempotency_key: str,
        params: dict[str, Any],
        send_params: dict[str, Any] | None = None,
    ) -> Any:
        """Cache by idempotency key + durable payload hash.

        `params` is hashed for conflict detection. `send_params` (when set) is
        what crosses the wire, so callers can keep volatile command ids out of
        the hash while still sending a full command envelope.
        """
        payload_hash = json.dumps(params, sort_keys=True, separators=(",", ":"))
        cached = self._idempotency.get(idempotency_key)
        if cached is not None:
            if cached["hash"] != payload_hash:
                raise ProtocolError(
                    "idempotency key reused with different payload",
                    code="IDEMPOTENCY_KEY_REUSED",
                )
            return cached["result"]
        result = await self.request(method, send_params if send_params is not None else params)
        self._idempotency[idempotency_key] = {"hash": payload_hash, "result": result}
        return result

    def on_notification(self, handler: Callable[[str, Any], None]) -> Callable[[], None]:
        self._notify.append(handler)

        def unsubscribe() -> None:
            if handler in self._notify:
                self._notify.remove(handler)

        return unsubscribe

    async def close(self) -> None:
        self._unsubscribe()
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ProtocolError("transport closed", code="TRANSPORT_CLOSED"))
        self._pending.clear()
        await self._transport.close()

    def _on_message(self, message: dict[str, Any]) -> None:
        if "id" in message and ("result" in message or "error" in message):
            future = self._pending.pop(message["id"], None)
            if future is None or future.done():
                return
            if "error" in message:
                error = message["error"]
                data = error.get("data") if isinstance(error, dict) else {}
                payload = data if isinstance(data, dict) else {}
                future.set_exception(
                    RpcError(
                        str(error.get("message", "rpc error")) if isinstance(error, dict) else "rpc error",
                        code=str(payload.get("code", "APP_RPC_ERROR")),
                        rpc_code=int(error.get("code", -32000)) if isinstance(error, dict) else -32000,
                        category=str(payload.get("category", "internal")),
                        retryable=bool(payload.get("retryable", False)),
                        details=payload.get("details") if isinstance(payload.get("details"), dict) else {},
                    )
                )
                return
            future.set_result(message.get("result"))
            return
        method = message.get("method")
        if isinstance(method, str):
            for handler in list(self._notify):
                handler(method, message.get("params"))


def default_socket_path() -> str:
    explicit = os.environ.get("CAPY_DAEMON_SOCK")
    if explicit:
        return explicit
    if sys.platform == "win32":
        uid = os.environ.get("USERNAME", "user")
        return rf"\\.\pipe\capybara-code-{uid}"
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        return str(Path(xdg) / "capybara-code" / "daemon.sock")
    uid = os.getuid() if hasattr(os, "getuid") else 0
    return str(Path("/tmp") / f"capybara-{uid}" / "daemon.sock")


async def open_local_connection(path: str) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """Unix domain socket, or a Windows named pipe."""
    if sys.platform != "win32":
        return await asyncio.open_unix_connection(path)
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await loop.create_pipe_connection(lambda: protocol, path)
    writer = asyncio.StreamWriter(transport, protocol, reader, loop)
    return reader, writer
