"""SkyRoute PLANNING CONSTRAINTS: areas the simulation avoids by its own policy.

`data/planning_constraints.geojson` (scripts/fetch_planning_constraints.py) holds the
real mapped OpenStreetMap footprints of airports (aeroway=aerodrome), military areas
and government buildings in Warsaw. They are NOT official UAS geographical zones:

* they enter the router as hard obstacles (BLOCKED, drawn red) through the same
  AirspaceRepository as official zones, so map and A* stay identical;
* they carry their own category (PLANNING) and source type (PLANNING_CONSTRAINT)
  and are labelled as SkyRoute policy, never as a legal no-fly boundary;
* they never change the official-data status: the wrapped dataset keeps the base
  provider's source type, label, timestamp and extent.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

from app.airspace.models import (
    AirspaceZone,
    AltitudeReference,
    DraCategory,
    RestrictionType,
    SourceType,
    VerificationStatus,
)
from app.airspace.providers import AirspaceDataset, AirspaceLoadError, AirspaceProvider, dedupe_zones
from app.config import PLANNING_CONSTRAINTS, PLANNING_CONSTRAINTS_FILE

KIND_LABEL = {"AIRPORT": "Airport grounds", "MILITARY": "Military area", "GOVERNMENT": "Government building"}
POLICY_NOTE = ("SkyRoute planning constraint (OSM-mapped {kind}): avoided by the simulation's own policy. "
               "Not an official UAS geographical zone and not a legal no-fly boundary.")


def load_constraints(path: Path) -> tuple[list[AirspaceZone], str]:
    """Zones and a content hash. A missing or broken file is an explicit error."""
    try:
        raw = path.read_bytes()
        fc = json.loads(raw)
    except (OSError, ValueError) as exc:
        raise AirspaceLoadError(f"Planning constraints file unreadable ({path}): {type(exc).__name__}") from exc
    fetched = (fc.get("metadata") or {}).get("fetchedAt")
    zones = []
    for f in fc.get("features", []):
        p, kind = f["properties"], f["properties"]["kind"]
        label = KIND_LABEL.get(kind, kind.title())
        zones.append(AirspaceZone(
            id=f"PLAN-{p['id']}", name=f"{label}: {p.get('name') or 'unnamed'}",
            dra_category=DraCategory.PLANNING, restriction_type=RestrictionType.PROHIBITED,
            geojson_geometry=f["geometry"], source=f"OpenStreetMap ({p['id']}), fetched {fetched or 'unknown'}",
            source_type=SourceType.PLANNING_CONSTRAINT, source_timestamp=None,
            validity_start=None, validity_end=None, lower_altitude=0.0, upper_altitude=None,
            altitude_reference=AltitudeReference.AGL, authorization_required=None,
            operational_conditions=POLICY_NOTE.format(kind=label.lower()),
            verification_status=VerificationStatus.PLANNING_CONSTRAINT,
        ))
    return zones, hashlib.sha256(raw).hexdigest()[:12]


class WithPlanningConstraints:
    """Adds the planning constraints to a provider's dataset without altering its metadata."""

    def __init__(self, base: AirspaceProvider, path: Path = PLANNING_CONSTRAINTS_FILE):
        self.base, self.path = base, path
        self.name = f"{base.name} + planning constraints"
        self._base_ds: AirspaceDataset | None = None
        self._stamp: tuple[float, int] | None = None
        self._version: str | None = None

    def _file_stamp(self) -> tuple[float, int] | None:
        try:
            st = self.path.stat()
            return st.st_mtime, st.st_size
        except OSError:
            return None

    def load(self) -> AirspaceDataset:
        ds = self.base.load()
        stamp = self._file_stamp()
        extra, digest = load_constraints(self.path)
        zones, dropped = dedupe_zones([*ds.zones, *extra], "airspace + planning constraints")
        version = hashlib.sha256(f"{ds.version}|{digest}".encode()).hexdigest()[:12]
        self._base_ds, self._stamp, self._version = ds, stamp, version
        return replace(ds, zones=zones, version=version, duplicates_removed=ds.duplicates_removed + dropped)

    def has_changed(self, dataset: AirspaceDataset) -> bool:
        if self._base_ds is None or dataset.version != self._version:
            return True
        return self.base.has_changed(self._base_ds) or self._file_stamp() != self._stamp


def with_planning_constraints(base: AirspaceProvider, mode: str = PLANNING_CONSTRAINTS,
                              path: Path = PLANNING_CONSTRAINTS_FILE) -> AirspaceProvider:
    """SKYROUTE_PLANNING_CONSTRAINTS=on (default) | off."""
    if mode == "off":
        return base
    if mode != "on":
        raise AirspaceLoadError(f"Unknown SKYROUTE_PLANNING_CONSTRAINTS '{mode}' (use on or off).")
    if not path.is_file():
        raise AirspaceLoadError(f"Planning constraints are on but {path} is missing "
                                "(run scripts/fetch_planning_constraints.py, or set SKYROUTE_PLANNING_CONSTRAINTS=off).")
    return WithPlanningConstraints(base, path)
