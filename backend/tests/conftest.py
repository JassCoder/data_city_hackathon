"""Shared helpers: a small synthetic world for routing tests and a real-data client."""

import os
import tempfile

# Tests never touch the developer's fleet database.
os.environ.setdefault("SKYROUTE_FLEET_DB", os.path.join(tempfile.mkdtemp(prefix="skyroute-test-"), "fleet.sqlite"))

from dataclasses import replace
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import box

from app.airspace.geometry import geodesic_circle, to_geojson
from app.airspace.models import AirspaceZone, Circle, DraCategory, RestrictionType, SourceType
from app.airspace.providers import AirspaceDataset
from app.airspace.repository import AirspaceRepository
from app.config import _BBOX
from app.geo.coverage import bbox_coverage
from app.main import app
from app.routing.grid import build_grid
from app.routing.planner import RoutePlanner
from app.schemas.layers import BuildingProperties, CorridorProperties
from app.schemas.planning import DroneProfile
from app.services.data_loader import Layer
from app.services.weather import _weather

# ~680 m x 670 m test area inside central Warsaw (27 x 27 cells of 25 m).
TEST_BBOX = {"minLon": 21.000, "minLat": 52.230, "maxLon": 21.010, "maxLat": 52.236}
WEST = (21.0010, 52.2330)  # lon, lat
EAST = (21.0090, 52.2330)
NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)

PROFILE = DroneProfile(
    id="TEST", name="Test drone", description="", cruise_speed_mps=10, max_wind_kmh=40,
    vertical_clearance_m=10, max_range_km=50, max_payload_kg=1, source="SYNTHETIC",
)
# No per-location samples: the planner then uses the top-level wind values.
CALM = _weather().model_copy(update={"wind_speed_kmh": 0.0, "wind_gust_kmh": None, "samples": []})

_DEFAULT_RESTRICTION = {
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


def lon_box(lon0, lat0, lon1, lat1):
    return box(lon0, lat0, lon1, lat1)


def zone(
    zid, geom=None, *, circle=None, category="DRA-P", restriction=None, lower=0.0, upper=300.0, ref="AGL",
    start=None, end=None, source="TEST", name=None,
) -> AirspaceZone:
    """Build a normalized zone. `geom`: shapely polygon (lon/lat); `circle`: (lon, lat, radius_m)."""
    cat = DraCategory(category)
    if circle:
        lon, lat, r = circle
        geom = geodesic_circle(lon, lat, r)
    return AirspaceZone(
        id=zid, name=name or zid, dra_category=cat,
        restriction_type=RestrictionType(restriction) if restriction else _DEFAULT_RESTRICTION[cat],
        geojson_geometry=to_geojson(geom), circle=Circle(center=circle[:2], radius_m=circle[2]) if circle else None,
        source=source, source_type=SourceType.SYNTHETIC, source_timestamp=None,
        validity_start=start, validity_end=end, lower_altitude=lower, upper_altitude=upper,
        altitude_reference=ref, authorization_required=None, operational_conditions=None,
        verification_status="SYNTHETIC",
    )


class StaticProvider:
    """In-memory airspace provider; `set_zones` simulates a dataset update."""

    name = "static"

    def __init__(self, zones=()):
        self.zones = list(zones)
        self.revision = 0

    def set_zones(self, zones):
        self.zones = list(zones)
        self.revision += 1

    def load(self) -> AirspaceDataset:
        return AirspaceDataset(
            provider=self.name, source_type=SourceType.SYNTHETIC, label="test zones", source_timestamp=None,
            disclaimer="", zones=list(self.zones), version=f"v{self.revision}", loaded_at=NOW,
        )

    def has_changed(self, dataset: AirspaceDataset) -> bool:
        return dataset.version != f"v{self.revision}"


class ApiTestProvider(StaticProvider):
    """Synthetic zones for API integration tests; the application default is empty."""

    def __init__(self):
        starts = datetime(2026, 9, 1, tzinfo=timezone.utc)
        expires = datetime(2026, 10, 1, tzinfo=timezone.utc)
        super().__init__([
            zone("-P-SEJM", lon_box(21.0245, 52.2236, 21.033, 52.2275), name="Sejm test zone"),
            zone("-P-CASTLE", circle=(21.016, 52.239, 140)),
            zone("-RM-PKIN", lon_box(21.005, 52.230, 21.011, 52.235), category="DRA-RM"),
            zone("-RH-SCHOOL-POWISLE", circle=(21.025, 52.239, 100), category="DRA-RH", upper=60),
            zone("-RH-SCHOOL-CENTRUM", circle=(21.019, 52.232, 100), category="DRA-RH", upper=60),
            zone("-RH-SCHOOL-WOLA", circle=(20.99, 52.235, 100), category="DRA-RH", upper=60),
            zone("-T-TECHNICAL", lon_box(21.043, 52.218, 21.046, 52.221), category="DRA-T"),
            zone("-U-USPACE", lon_box(21.043, 52.245, 21.046, 52.248), category="DRA-U"),
            zone("-I-VISTULA", lon_box(21.03, 52.23, 21.035, 52.24), category="DRA-I"),
            zone("-RL-EVENT", lon_box(21.012, 52.22, 21.014, 52.222), category="DRA-RL",
                 start=starts, end=expires),
            zone("-X-INCOMPLETE", lon_box(21.045, 52.24, 21.047, 52.242), category="UNKNOWN"),
        ])

    def load(self) -> AirspaceDataset:
        dataset = super().load()
        return replace(
            dataset,
            provider="synthetic-test-fixtures",
            label="Synthetic API test fixtures",
            disclaimer="SYNTHETIC TEST FIXTURES. Not official PAŻP geographical zones.",
            extent=box(_BBOX["minLon"], _BBOX["minLat"], _BBOX["maxLon"], _BBOX["maxLat"]),
            extent_label="synthetic test extent",
        )


def make_planner(zones=(), buildings=(), river=None, margin_m=20.0) -> RoutePlanner:
    """zones: [AirspaceZone], buildings: [(polygon, height_m)], lon/lat polygons."""
    b_props = [BuildingProperties(id=f"b{i}", height_m=h, height_source="osm_height") for i, (_, h) in enumerate(buildings)]
    c_props, c_geoms = [], []
    if river is not None:
        c_props, c_geoms = [CorridorProperties(id="river", corridor_type="RIVER")], [river]
    area = box(TEST_BBOX["minLon"], TEST_BBOX["minLat"], TEST_BBOX["maxLon"], TEST_BBOX["maxLat"])
    grid = build_grid(Layer(c_props, c_geoms, {}), Layer(b_props, [g for g, _ in buildings], {}), area)
    return RoutePlanner(grid, AirspaceRepository(StaticProvider(zones), grid, margin_m), bbox_coverage(TEST_BBOX))


@pytest.fixture(scope="session")
def client():
    # Planning constraints (real OSM file) are left out here and tested in test_planning_constraints.py.
    with patch("app.main.make_provider", return_value=ApiTestProvider()), \
            patch("app.main.with_planning_constraints", side_effect=lambda p: p):
        with TestClient(app) as c:  # runs startup against real map data and test-only airspace
            yield c


@pytest.fixture
def overrides():
    yield app.dependency_overrides
    app.dependency_overrides.clear()
