"""Shared helpers: a small synthetic world for routing tests and a real-data client."""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import box

from app.airspace.geometry import geodesic_circle, to_geojson
from app.airspace.models import AirspaceZone, Circle, DraCategory, RestrictionType, SourceType
from app.airspace.providers import AirspaceDataset
from app.airspace.repository import AirspaceRepository
from app.main import app
from app.routing.grid import build_grid
from app.routing.planner import RoutePlanner
from app.schemas.layers import BuildingProperties, CorridorProperties, StationProperties
from app.schemas.planning import DroneProfile
from app.services.data_loader import DemoData, Layer
from app.services.weather import demo_weather

# ~680 m x 670 m test area inside central Warsaw (27 x 27 cells of 25 m).
TEST_BBOX = {"minLon": 21.000, "minLat": 52.230, "maxLon": 21.010, "maxLat": 52.236}
WEST = (21.0010, 52.2330)  # lon, lat
EAST = (21.0090, 52.2330)
NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)

PROFILE = DroneProfile(
    id="TEST", name="Test drone", description="", cruise_speed_mps=10, max_wind_kmh=40,
    vertical_clearance_m=10, max_range_km=50, max_payload_kg=1, source="DEMO",
)
CALM = demo_weather().model_copy(update={"wind_speed_kmh": 0.0, "wind_gust_kmh": None})

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
        source=source, source_type=SourceType.DEMO, source_timestamp=None,
        validity_start=start, validity_end=end, lower_altitude=lower, upper_altitude=upper,
        altitude_reference=ref, authorization_required=None, operational_conditions=None,
        verification_status="SYNTHETIC_DEMO",
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
            provider=self.name, source_type=SourceType.DEMO, label="test zones", source_timestamp=None,
            disclaimer="", zones=list(self.zones), version=f"v{self.revision}", loaded_at=NOW,
        )

    def has_changed(self, dataset: AirspaceDataset) -> bool:
        return dataset.version != f"v{self.revision}"


def make_planner(zones=(), buildings=(), river=None, margin_m=20.0) -> RoutePlanner:
    """zones: [AirspaceZone], buildings: [(polygon, height_m)], lon/lat polygons."""
    b_props = [BuildingProperties(id=f"b{i}", height_m=h, height_source="osm_height") for i, (_, h) in enumerate(buildings)]
    c_props, c_geoms = [], []
    if river is not None:
        c_props, c_geoms = [CorridorProperties(id="river", corridor_type="RIVER")], [river]
    data = DemoData(
        corridors=Layer(c_props, c_geoms, {}),
        buildings=Layer(b_props, [g for g, _ in buildings], {}),
        stations=Layer[StationProperties]([], [], {}),
        layers_json=b"",
    )
    grid = build_grid(data, TEST_BBOX)
    return RoutePlanner(grid, AirspaceRepository(StaticProvider(zones), grid, margin_m), TEST_BBOX)


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:  # runs the startup lifespan on the real /data files
        yield c


@pytest.fixture
def overrides():
    yield app.dependency_overrides
    app.dependency_overrides.clear()
