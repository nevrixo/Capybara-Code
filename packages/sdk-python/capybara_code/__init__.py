"""Capybara Code asyncio client SDK (App Protocol 1.0)."""

from .approvals import ApprovalDecision
from .client import CapybaraClient
from .errors import CapybaraError, ProtocolError, RpcError
from .generated import APP_METHODS, EVENT_KINDS, EVENT_SCHEMA_VERSION, PROTOCOL_VERSION
from .session import Session
from .stream import EventStream

__all__ = [
    "APP_METHODS",
    "ApprovalDecision",
    "CapybaraClient",
    "CapybaraError",
    "EVENT_KINDS",
    "EVENT_SCHEMA_VERSION",
    "EventStream",
    "PROTOCOL_VERSION",
    "ProtocolError",
    "RpcError",
    "Session",
]

__version__ = "0.1.0"
