import gzip
import json
import shutil

import pytest
from shapely.geometry import box, shape

from app.airspace.factory import make_provider
from app.airspace.models import DraCategory
from app.config import BUILDING_TILES_DIR, DATA_DIR, DATA_FILES, DEMO_BBOX
from app.services.data_loader import DataLoadError, load_demo_data


@pytest.fixture(scope="module")
def data():
    return load_demo_data()


@pytest.fixture(scope="module")
def demo_zones():
    return make_provider("demo").load().zones


def test_all_layers_load(data):
    assert len(data.stations.properties) == 4
    assert all(p.height_m >= 50 for p in data.tall_buildings.properties)
    assert data.building_stats["buildings"] > 50_000  # citywide OSM snapshot
    corridor_types = {p.corridor_type for p in data.corridors.properties}
    assert corridor_types == {"RIVER", "PARK"}


def test_no_station_inside_a_non_information_zone(data, demo_zones):
    for sp, sg in zip(data.stations.properties, data.stations.geometries):
        for z in demo_zones:
            if z.dra_category != DraCategory.I:
                assert not shape(z.geojson_geometry).intersects(sg), f"station {sp.id} is inside zone {z.id}"


def test_stations_and_zones_inside_bbox(data, demo_zones):
    bbox = box(DEMO_BBOX["minLon"], DEMO_BBOX["minLat"], DEMO_BBOX["maxLon"], DEMO_BBOX["maxLat"])
    for g in data.stations.geometries + [shape(z.geojson_geometry) for z in demo_zones]:
        assert bbox.contains(g)


def test_building_heights_follow_source_rules():
    tiles = sorted(BUILDING_TILES_DIR.glob("14/*/*.json.gz"))[:20]
    assert tiles
    for t in tiles:
        for f in json.loads(gzip.decompress(t.read_bytes()))["features"]:
            p = f["properties"]
            assert p["height_m"] > 0
            if p["height_source"] == "default_15m":
                assert p["height_m"] == 15


def test_missing_file_fails_with_clear_message(tmp_path):
    for key, name in DATA_FILES.items():
        if key != "stations":
            shutil.copy(DATA_DIR / name, tmp_path / name)
    with pytest.raises(DataLoadError, match="Missing data file .*landing_stations.geojson"):
        load_demo_data(tmp_path)


def test_invalid_station_type_is_rejected(tmp_path):
    for name in DATA_FILES.values():
        shutil.copy(DATA_DIR / name, tmp_path / name)
    path = tmp_path / DATA_FILES["stations"]
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["features"][0]["properties"]["station_type"] = "SPACEPORT"
    path.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(DataLoadError, match="landing_stations.geojson"):
        load_demo_data(tmp_path)


def test_layers_endpoint(client):
    res = client.get("/api/v1/layers", headers={"Accept-Encoding": "gzip"})
    assert res.status_code == 200
    assert res.headers["content-encoding"] == "gzip"
    body = res.json()
    assert set(body) == {"corridors", "tallBuildings", "stations", "buildingStats"}  # zones: /zones, buildings: tiles
    assert body["stations"]["features"][0]["properties"]["source"] == "DEMO"
    assert body["tallBuildings"]["features"][0]["properties"].keys() == {"id", "height_m", "height_source"}
    assert body["buildingStats"]["buildings"] > 50_000
