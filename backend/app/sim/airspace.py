"""Temporary scenario zones (zone_activate / zone_deactivate events) layered on the DEMO zones.

The planner's AirspaceRepository reloads whenever its provider reports a change, so
the engine wraps the existing provider and adds the active scenario zones. The
dataset version is a content hash of the base version plus the active zones, so it
is deterministic and two engines sharing a world never see each other's zones
(each engine syncs its own set before planning).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace

from app.airspace.geometry import geodesic_circle, to_geojson
from app.airspace.models import AirspaceZone, AltitudeReference, Circle, DraCategory, RestrictionType, SourceType, VerificationStatus
from app.airspace.providers import AirspaceDataset, AirspaceProvider
from shapely.geometry import Polygon

from app.sim.scenario import ZoneActivateEvent

DEFAULT_RESTRICTION = {
    DraCategory.P: RestrictionType.PROHIBITED,
    DraCategory.R: RestrictionType.AUTHORIZATION_REQUIRED,
    DraCategory.RH: RestrictionType.AUTHORIZATION_REQUIRED,
    DraCategory.RM: RestrictionType.AUTHORIZATION_REQUIRED,
    DraCategory.RL: RestrictionType.AUTHORIZATION_REQUIRED,
    DraCategory.T: RestrictionType.TECHNICAL_REQUIREMENTS,
    DraCategory.U: RestrictionType.USPACE_SERVICES_REQUIRED,
    DraCategory.I: RestrictionType.INFORMATION,
    DraCategory.UNKNOWN: RestrictionType.UNKNOWN,
}


def scenario_zone(e: ZoneActivateEvent) -> AirspaceZone:
    """A synthetic DEMO zone from a zone_activate event."""
    if e.circle:
        geom = geodesic_circle(e.circle.longitude, e.circle.latitude, e.circle.radius_m)
        circle = Circle(center=(e.circle.longitude, e.circle.latitude), radius_m=e.circle.radius_m)
    else:
        geom, circle = Polygon(e.polygon), None
    return AirspaceZone(
        id=e.zone_id, name=e.name, dra_category=e.category, restriction_type=DEFAULT_RESTRICTION[e.category],
        geojson_geometry=to_geojson(geom), circle=circle, source="SIMULATION scenario event (synthetic)",
        source_type=SourceType.DEMO, source_timestamp=None, validity_start=None, validity_end=None,
        lower_altitude=e.lower_m, upper_altitude=e.upper_m, altitude_reference=AltitudeReference.AGL,
        authorization_required=None, operational_conditions="Temporary zone from a simulation scenario event.",
        verification_status=VerificationStatus.SYNTHETIC_DEMO,
    )


class ScenarioZoneProvider:
    """Base airspace provider + the currently active scenario zones."""

    name = "scenario"

    def __init__(self, base: AirspaceProvider):
        self.base = base
        self.extra: dict[str, AirspaceZone] = {}
        self._base_ds: AirspaceDataset | None = None

    def set_zones(self, zones: dict[str, AirspaceZone]) -> None:
        self.extra = dict(zones)

    def _suffix(self) -> str:
        if not self.extra:
            return ""
        blob = json.dumps([self.extra[k].model_dump(mode="json") for k in sorted(self.extra)], sort_keys=True)
        return "+sim" + hashlib.sha256(blob.encode()).hexdigest()[:10]

    def load(self) -> AirspaceDataset:
        if self._base_ds is None or self.base.has_changed(self._base_ds):
            self._base_ds = self.base.load()
        ds = self._base_ds
        if not self.extra:
            return ds
        return replace(ds, zones=[*ds.zones, *(self.extra[k] for k in sorted(self.extra))],
                       version=ds.version + self._suffix())

    def has_changed(self, dataset: AirspaceDataset) -> bool:
        if self._base_ds is None or self.base.has_changed(self._base_ds):
            return True
        return dataset.version != self._base_ds.version + self._suffix()
