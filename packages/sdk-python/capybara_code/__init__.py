"""Capybara Code asyncio client SDK (App Protocol 1.0)."""

from .approvals import ApprovalDecision
from .client import CapybaraClient
from .errors import CapybaraError, ProtocolError, RpcError
from .session import Session
from .stream import EventStream

__all__ = [
    "ApprovalDecision",
    "CapybaraClient",
    "CapybaraError",
    "EventStream",
    "ProtocolError",
    "RpcError",
    "Session",
]

__version__ = "0.1.0"
PROTOCOL_VERSION = "1.0"
