import gzip
import json
import shutil

import pytest
from shapely.geometry import box, shape

from app.airspace.factory import make_provider
from app.airspace.models import DraCategory
from app.config import BUILDING_TILES_DIR, DATA_DIR, DATA_FILES, _BBOX
from app.services.data_loader import DataLoadError, load__data


@pytest.fixture(scope="module")
def data():
    return load__data()


@pytest.fixture(scope="module")
def _zones():
    return make_provider("").load().zones


def test_all_layers_load(data):
    assert len(data.stations.properties) == 4
    assert all(p.height_m >= 50 for p in data.tall_buildings.properties)
    assert data.building_stats["buildings"] > 50_000  # citywide OSM snapshot
    corridor_types = {p.corridor_type for p in data.corridors.properties}
    assert corridor_types == {"RIVER", "PARK"}


def test_no_station_inside_a_non_information_zone(data, _zones):
    for sp, sg in zip(data.stations.properties, data.stations.geometries):
        for z in _zones:
            if z.dra_category != DraCategory.I:
                assert not shape(z.geojson_geometry).intersects(sg), f"station {sp.id} is inside zone {z.id}"


def test_stations_and_zones_inside_bbox(data, _zones):
    bbox = box(_BBOX["minLon"], _BBOX["minLat"], _BBOX["maxLon"], _BBOX["maxLat"])
    for g in data.stations.geometries + [shape(z.geojson_geometry) for z in _zones]:
        assert bbox.contains(g)


def test_building_heights_follow_source_rules():
    tiles = sorted(BUILDING_TILES_DIR.glob("14/*/*.json.gz"))[:20]
    assert tiles
    for t in tiles:
        for f in json.loads(gzip.decompress(t.read_bytes()))["features"]:
            p = f["properties"]
            if p["height_source"] == "unknown":
                assert p["height_m"] is None  # unknown heights are never invented
            else:
                assert p["height_source"] in ("osm_height", "levels_x3") and p["height_m"] > 0


def test_missing_file_fails_with_clear_message(tmp_path):
    for key, name in DATA_FILES.items():
        if key != "stations":
            shutil.copy(DATA_DIR / name, tmp_path / name)
    with pytest.raises(DataLoadError, match="Missing data file .*landing_stations.geojson"):
        load__data(tmp_path)


def test_invalid_station_type_is_rejected(tmp_path):
    for name in DATA_FILES.values():
        shutil.copy(DATA_DIR / name, tmp_path / name)
    path = tmp_path / DATA_FILES["stations"]
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["features"][0]["properties"]["station_type"] = "SPACEPORT"
    path.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(DataLoadError, match="landing_stations.geojson"):
        load__data(tmp_path)


def test_layers_endpoint(client):
    res = client.get("/api/v1/layers", headers={"Accept-Encoding": "gzip"})
    assert res.status_code == 200
    assert res.headers["content-encoding"] == "gzip"
    body = res.json()
    assert set(body) == {"corridors", "tallBuildings", "stations", "buildingStats"}  # zones: /zones, buildings: tiles
    assert body["stations"]["features"][0]["properties"]["source"] == "SYNTHETIC"
    assert body["tallBuildings"]["features"][0]["properties"].keys() == {"id", "height_m", "height_source"}
    assert body["buildingStats"]["buildings"] > 50_000
