"""Append-only simulation event log."""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Any, Mapping


class EventType(StrEnum):
    STATE_CHANGED = "STATE_CHANGED"
    MISSION_ASSIGNED = "MISSION_ASSIGNED"
    MISSION_REJECTED = "MISSION_REJECTED"
    ROUTE_PLANNED = "ROUTE_PLANNED"
    REPLANNED = "REPLANNED"
    DELIVERED = "DELIVERED"
    MISSION_COMPLETED = "MISSION_COMPLETED"
    MISSION_ABORTED = "MISSION_ABORTED"
    BATTERY_WARNING = "BATTERY_WARNING"
    EMERGENCY = "EMERGENCY"  # why an emergency landing started and where it goes
    CHARGED = "CHARGED"
    FAILURE = "FAILURE"
    SCENARIO_EVENT = "SCENARIO_EVENT"  # a timed scenario event was applied


def _clean(v: Any) -> Any:
    """JSON-friendly, stable details: floats rounded, tuples as lists, enums as values."""
    if isinstance(v, float):
        return round(v, 3)
    if isinstance(v, StrEnum):
        return v.value
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if isinstance(v, Mapping):
        return {str(k): _clean(x) for k, x in v.items()}
    return v


@dataclass(frozen=True)
class SimEvent:
    seq: int
    t_s: float
    drone_id: str | None
    type: EventType
    details: Mapping[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {"seq": self.seq, "tS": self.t_s, "droneId": self.drone_id, "type": self.type.value,
                "details": dict(self.details)}


class EventLog:
    """Events can only be appended; readers get immutable copies."""

    def __init__(self) -> None:
        self._events: list[SimEvent] = []

    def append(self, t_s: float, drone_id: str | None, type: EventType, **details: Any) -> SimEvent:
        event = SimEvent(len(self._events), round(t_s, 3), drone_id, type, MappingProxyType(_clean(details)))
        self._events.append(event)
        return event

    @property
    def events(self) -> tuple[SimEvent, ...]:
        return tuple(self._events)

    def to_dicts(self) -> list[dict[str, Any]]:
        return [e.to_dict() for e in self._events]

    def to_jsonl(self) -> str:
        return "\n".join(json.dumps(e, ensure_ascii=False, sort_keys=True) for e in self.to_dicts())

    def __len__(self) -> int:
        return len(self._events)
