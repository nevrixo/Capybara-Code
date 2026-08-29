"""Capybara Code asyncio client SDK (App Protocol 1.0)."""

from .approvals import ApprovalDecision
from .client import CapybaraClient
from .errors import CapybaraError, ProtocolError, RpcError
from .generated import (
    APP_METHODS,
    CAPABILITY_SCHEMA_REVISION,
    EVENT_KINDS,
    EVENT_SCHEMA_VERSION,
    METHOD_CAPABILITY_STATES,
    PROTOCOL_VERSION,
)
from .session import Session
from .stream import EventStream

__all__ = [
    "APP_METHODS",
    "ApprovalDecision",
    "CapybaraClient",
    "CapybaraError",
    "CAPABILITY_SCHEMA_REVISION",
    "EVENT_KINDS",
    "EVENT_SCHEMA_VERSION",
    "EventStream",
    "METHOD_CAPABILITY_STATES",
    "PROTOCOL_VERSION",
    "ProtocolError",
    "RpcError",
    "Session",
]

__version__ = "0.1.0"
