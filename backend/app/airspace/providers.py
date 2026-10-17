"""Airspace providers. Each returns zones in the normalized `AirspaceZone` form.

- `GeoJsonZoneFileProvider`: a FeatureCollection whose properties already use
  the normalized field names (camelCase). Used for the DEMO dataset and for
  official snapshots converted to this format.
- `Ed269FileProvider`: an EUROCAE ED-269-style JSON export (the EU format for
  UAS geographical zones under Regulation (EU) 2019/947). No official Polish
  file is bundled; the mapping follows the ED-269 structure and must be checked
  against the real file once PAŻP supplies one.

No provider calls a remote service: PAŻP does not publish a documented,
permitted zone API (see DATA_SOURCES.md).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from pydantic import ValidationError
from shapely.geometry import box, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from app.airspace.geometry import as_area, geodesic_circle, to_geojson
from app.airspace.models import (
    AirspaceZone,
    AltitudeReference,
    Circle,
    DraCategory,
    RestrictionType,
    SourceType,
    VerificationStatus,
)


class AirspaceLoadError(RuntimeError):
    pass


@dataclass(frozen=True)
class AirspaceDataset:
    provider: str
    source_type: SourceType
    label: str
    source_timestamp: datetime | None
    disclaimer: str
    zones: list[AirspaceZone]
    version: str  # content hash: changes whenever the dataset changes
    loaded_at: datetime
    # Area the dataset claims to cover (WGS84). None = the whole routing area.
    # Outside it, zones are unknown: routes there are flagged as not checked.
    extent: BaseGeometry | None = None
    extent_label: str | None = None


class AirspaceProvider(Protocol):
    name: str

    def load(self) -> AirspaceDataset: ...

    def has_changed(self, dataset: AirspaceDataset) -> bool: ...


def _read(path: Path) -> tuple[bytes, Any]:
    if not path.is_file():
        raise AirspaceLoadError(f"Airspace file not found: {path}")
    raw = path.read_bytes()
    try:
        return raw, json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AirspaceLoadError(f"{path.name} is not valid JSON: {exc}") from exc


def _version(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()[:12]


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class _FileProvider:
    def __init__(self, path: Path):
        self.path = path

    def has_changed(self, dataset: AirspaceDataset) -> bool:
        try:
            return _version(self.path.read_bytes()) != dataset.version
        except OSError:
            return False  # keep serving the last good dataset


class GeoJsonZoneFileProvider(_FileProvider):
    name = "geojson-file"

    def load(self) -> AirspaceDataset:
        raw, doc = _read(self.path)
        meta = doc.get("metadata", {}) if isinstance(doc, dict) else {}
        try:
            source_type = SourceType(meta.get("sourceType", "DEMO"))
        except ValueError as exc:
            raise AirspaceLoadError(f"{self.path.name}: unknown metadata.sourceType") from exc
        zones, errors = [], []
        for i, f in enumerate(doc.get("features", []) if isinstance(doc, dict) else []):
            try:
                zones.append(self._zone(f, source_type))
            except (KeyError, TypeError, ValueError, ValidationError) as exc:
                errors.append(f"feature {i}: {exc}")
        if errors:
            raise AirspaceLoadError(f"Invalid zones in {self.path.name}:\n" + "\n".join(errors))
        ids = [z.id for z in zones]
        if len(set(ids)) != len(ids):
            raise AirspaceLoadError(f"{self.path.name}: duplicate zone ids")
        return AirspaceDataset(
            provider=meta.get("provider", self.name),
            source_type=source_type,
            label=meta.get("label", self.path.name),
            source_timestamp=_parse_dt(meta.get("sourceTimestamp")),
            disclaimer=meta.get("disclaimer", ""),
            zones=zones,
            version=_version(raw),
            loaded_at=datetime.now(timezone.utc),
            extent=self._extent(meta.get("extent")),
            extent_label=meta.get("extentLabel"),
        )

    @staticmethod
    def _extent(value) -> BaseGeometry | None:
        if not value:
            return None
        if {"minLon", "minLat", "maxLon", "maxLat"} <= set(value):
            return box(value["minLon"], value["minLat"], value["maxLon"], value["maxLat"])
        return shape(value)

    @staticmethod
    def _zone(feature: dict, source_type: SourceType) -> AirspaceZone:
        props = dict(feature["properties"])
        circle = Circle.model_validate(props["circle"]) if props.get("circle") else None
        if circle:
            geom = geodesic_circle(circle.center[0], circle.center[1], circle.radius_m)
        elif feature.get("geometry"):
            geom = as_area(feature["geometry"])
        else:
            raise ValueError("zone has neither geometry nor circle")
        props.setdefault("sourceType", source_type.value)
        props["geojsonGeometry"] = to_geojson(geom)
        return AirspaceZone.model_validate(props)


# --- ED-269 ------------------------------------------------------------------

_DRA_RE = re.compile(r"\bDRA[-_ ]?(RH|RM|RL|P|R|T|U|I)\b", re.IGNORECASE)
_RESTRICTION = {
    "PROHIBITED": RestrictionType.PROHIBITED,
    "REQ_AUTHORISATION": RestrictionType.AUTHORIZATION_REQUIRED,
    "REQ_AUTHORIZATION": RestrictionType.AUTHORIZATION_REQUIRED,
    "CONDITIONAL": RestrictionType.CONDITIONAL,
    "NO_RESTRICTION": RestrictionType.INFORMATION,
}
_REFERENCE = {"AGL": AltitudeReference.AGL, "AMSL": AltitudeReference.AMSL}
_FT = 0.3048


class Ed269FileProvider(_FileProvider):
    name = "ed269-file"

    def __init__(self, path: Path, label: str = "PAŻP ED-269 snapshot"):
        super().__init__(path)
        self.label = label

    def load(self) -> AirspaceDataset:
        raw, doc = _read(self.path)
        features = doc.get("features") if isinstance(doc, dict) else None
        if not isinstance(features, list):
            raise AirspaceLoadError(f"{self.path.name}: expected an ED-269 object with a 'features' list")
        zones, errors = [], []
        for i, f in enumerate(features):
            try:
                zones.append(self.parse_feature(f))
            except (KeyError, TypeError, ValueError, ValidationError) as exc:
                errors.append(f"feature {i} ({f.get('identifier', '?') if isinstance(f, dict) else '?'}): {exc}")
        if errors:
            raise AirspaceLoadError(f"Invalid ED-269 features in {self.path.name}:\n" + "\n".join(errors))
        return AirspaceDataset(
            provider=self.name,
            source_type=SourceType.PERMITTED_SNAPSHOT,
            label=doc.get("title") or self.label,
            source_timestamp=_parse_dt(doc.get("issued") or doc.get("updateDateTime")),
            disclaimer="Official snapshot loaded from file. Check currency in PAŻP DroneMap/DroneTower before any real flight.",
            zones=zones,
            version=_version(raw),
            loaded_at=datetime.now(timezone.utc),
        )

    @staticmethod
    def parse_feature(f: dict) -> AirspaceZone:
        text = " ".join(str(f.get(k) or "") for k in ("identifier", "name", "otherReasonInfo", "message"))
        m = _DRA_RE.search(text)
        category = DraCategory(f"DRA-{m.group(1).upper()}") if m else DraCategory.UNKNOWN
        restriction = _RESTRICTION.get(str(f.get("restriction", "")).upper(), RestrictionType.UNKNOWN)

        polys, circle, lowers, uppers, refs = [], None, [], [], set()
        for vol in f["geometry"]:
            hp = vol["horizontalProjection"]
            factor = _FT if str(vol.get("uomDimensions", "M")).upper() == "FT" else 1.0
            if hp["type"] == "Circle":
                lon, lat = hp["center"]
                radius = float(hp["radius"]) * factor
                polys.append(geodesic_circle(lon, lat, radius))
                circle = Circle(center=(lon, lat), radius_m=radius) if len(f["geometry"]) == 1 else None
            else:
                polys.append(as_area(hp))
            lowers.append(None if vol.get("lowerLimit") is None else float(vol["lowerLimit"]) * factor)
            uppers.append(None if vol.get("upperLimit") is None else float(vol["upperLimit"]) * factor)
            refs.add(_REFERENCE.get(str(vol.get("lowerVerticalReference", "")).upper(), AltitudeReference.UNKNOWN))
            refs.add(_REFERENCE.get(str(vol.get("upperVerticalReference", "")).upper(), AltitudeReference.UNKNOWN))

        # Several volumes collapse to one envelope: lowest floor, highest ceiling.
        lower = None if None in lowers else min(lowers)
        upper = None if None in uppers else max(uppers)
        reference = refs.pop() if len(refs) == 1 else AltitudeReference.UNKNOWN

        start = end = None
        conditions = [str(f["message"])] if f.get("message") else []
        apps = f.get("applicability") or []
        if apps and not all(str(a.get("permanent", "")).upper() == "YES" for a in apps):
            starts = [_parse_dt(a.get("startDateTime")) for a in apps]
            ends = [_parse_dt(a.get("endDateTime")) for a in apps]
            start = None if None in starts else min(starts)
            end = None if None in ends else max(ends)
            if any(a.get("schedule") for a in apps):
                conditions.append("Daily schedule present but not evaluated: zone treated as active for its whole period.")
        conditions += [str(c) for c in f.get("restrictionConditions") or []]

        return AirspaceZone(
            id=str(f["identifier"]),
            name=str(f.get("name") or f["identifier"]),
            dra_category=category,
            restriction_type=restriction,
            geojson_geometry=to_geojson(unary_union(polys)),
            circle=circle,
            source="PAŻP (ED-269 file)",
            source_type=SourceType.PERMITTED_SNAPSHOT,
            source_timestamp=None,
            validity_start=start,
            validity_end=end,
            lower_altitude=lower,
            upper_altitude=upper,
            altitude_reference=reference,
            authorization_required={
                RestrictionType.PROHIBITED: True,
                RestrictionType.AUTHORIZATION_REQUIRED: True,
                RestrictionType.INFORMATION: False,
            }.get(restriction),
            operational_conditions=" ".join(conditions) or None,
            verification_status=VerificationStatus.OFFICIAL_UNVERIFIED_LOCALLY,
        )
