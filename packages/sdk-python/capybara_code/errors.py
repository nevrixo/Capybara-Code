"""Typed SDK exceptions carrying App Protocol domain codes."""

from __future__ import annotations

from typing import Any


class CapybaraError(Exception):
    """Base SDK error."""

    def __init__(self, message: str, *, code: str = "CAPY_ERROR", details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


class ProtocolError(CapybaraError):
    """Local framing / handshake failure."""

    def __init__(self, message: str, *, code: str = "PROTOCOL_ERROR", details: dict[str, Any] | None = None) -> None:
        super().__init__(message, code=code, details=details)


class RpcError(CapybaraError):
    """JSON-RPC error returned by the daemon."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        rpc_code: int,
        category: str = "internal",
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, code=code, details=details)
        self.rpc_code = rpc_code
        self.category = category
        self.retryable = retryable
