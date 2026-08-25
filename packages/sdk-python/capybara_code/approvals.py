"""Approval decision helpers for interactive / headless clients."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


DecisionKind = Literal["allow_once", "allow_session", "deny"]


@dataclass(frozen=True, slots=True)
class ApprovalDecision:
    kind: DecisionKind
    reason: str | None = None

    @staticmethod
    def allow_once() -> ApprovalDecision:
        return ApprovalDecision(kind="allow_once")

    @staticmethod
    def allow_session() -> ApprovalDecision:
        return ApprovalDecision(kind="allow_session")

    @staticmethod
    def deny(reason: str) -> ApprovalDecision:
        return ApprovalDecision(kind="deny", reason=reason)

    def to_payload(self) -> dict[str, Any]:
        if self.kind == "deny":
            return {"kind": "deny", "reason": self.reason or "denied"}
        return {"kind": self.kind}


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    approval_id: str
    session_id: str
    turn_id: str
    title: str
    summary: str
    action_hash: str
    network: bool = False
    raw: dict[str, Any] | None = None
