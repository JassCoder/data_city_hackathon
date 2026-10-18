"""Address geocoding (building numbers, flats, entrances), the simplified route contract,
Warsaw calculation time and LIVE weather failure handling. No network: everything is mocked."""

import asyncio
import gzip
import json
from datetime import datetime, timezone

import httpx
import pytest
from shapely.geometry import box, mapping

from app.dependencies import get_weather
from app.geo.buildings import tile_of
from app.schemas.planning import RouteRequest, WeatherMode, WeatherSource
from app.services.address import (
    Accuracy,
    AddressGeocoder,
    GugikAddressProvider,
    classify_nominatim,
    parse_query,
    same_street,
)
from app.services.clock import to_warsaw, warsaw_now, warsaw_offset
from app.services.entrances import EntranceIndex, flats_contain
from app.services.geocoding import GeocodingError, NominatimProvider
from app.services.weather import WeatherService

URL = "/api/v1/routes/calculate"
A = {"latitude": 52.2405, "longitude": 20.9650}
B = {"latitude": 52.2110, "longitude": 21.0450}


def run(coro):
    return asyncio.run(coro)


# --- parsing --------------------------------------------------------------------------

@pytest.mark.parametrize("q, street, number, flat", [
    ("Marszałkowska 100, Warszawa", "Marszałkowska", "100", None),
    ("Międzynarodowa 32/34A, Warszawa", "Międzynarodowa", "32/34A", None),
    ("Al. Jerozolimskie 54, Warszawa", "Aleje Jerozolimskie", "54", None),
    ("ul. Puławska 2 m. 15", "Puławska", "2", "15"),
    ("Nowy Świat 10 lok 3, 00-001 Warszawa", "Nowy Świat", "10", "3"),
    ("plac Defilad 1", "Plac Defilad", "1", None),
])
def test_parse_street_number_and_flat(q, street, number, flat):
    p = parse_query(q)
    assert (p.street, p.number, p.flat) == (street, number, flat)


def test_parse_place_names_and_coordinates():
    assert parse_query("Warszawa Centralna").number is None
    p = parse_query("52.2297, 21.0122")
    assert p.is_coordinates and (p.latitude, p.longitude) == (52.2297, 21.0122)


def test_street_matching_rejects_a_different_street():
    assert same_street("Nowy Świat", "ulica Nowy Świat")
    assert same_street("Al. Jerozolimskie", "Aleje Jerozolimskie")
    assert not same_street("Nowy Świat", "ulica Nowa")  # the service's fuzzy match must not be trusted blindly


# --- GUGiK PRG address points -------------------------------------------------------------

def uug(*items):
    return {"type": "address", "results": {str(i + 1): it for i, it in enumerate(items)}}


def item(street, number, x=21.0033, y=52.2286):
    return {"street": street, "number": number, "x": str(x), "y": str(y), "city": "Warszawa", "code": "00-024",
            "teryt": "146501", "ulic": "45207"}


def test_gugik_returns_only_the_exact_building_on_the_requested_street():
    payload = uug(item("Aleje Jerozolimskie", "54"), item("Aleje Jerozolimskie", "56"), item("ulica Nowa", "54"))
    res = GugikAddressProvider.parse(payload, "Aleje Jerozolimskie", "54")
    assert len(res) == 1 and res[0].accuracy == Accuracy.ADDRESS and res[0].house_number == "54"
    assert res[0].source == "gugik-prg" and (res[0].latitude, res[0].longitude) == (52.2286, 21.0033)


class FakeNominatim:
    name, attribution = "nominatim", "OSM"

    def __init__(self, items=(), fail=False):
        self.items, self.fail, self.queries = list(items), fail, []

    async def search_raw(self, query, limit):
        self.queries.append(query)
        if self.fail:
            raise GeocodingError("down")
        return [(raw, NominatimProvider.parse([raw])[0]) for raw in self.items]


class FakeGugik:
    def __init__(self, by_number=None, fail=False):
        self.by_number, self.fail, self.calls = by_number or {}, fail, []

    async def lookup(self, street, number, city="Warszawa"):
        self.calls.append((street, number))
        if self.fail:
            raise GeocodingError("down")
        return GugikAddressProvider.parse(uug(*self.by_number.get(number, [])), street, number)


def nom(name, lat, lon, house=None, road="Marszałkowska", addresstype="road"):
    return {"place_id": 1, "lat": str(lat), "lon": str(lon), "display_name": name, "category": "highway",
            "type": "residential", "addresstype": addresstype,
            "address": {k: v for k, v in (("house_number", house), ("road", road)) if v}}


def test_building_number_match_comes_first():
    g = AddressGeocoder(FakeGugik({"54": [item("Aleje Jerozolimskie", "54")]}),
                        FakeNominatim([nom("Aleje Jerozolimskie", 52.2290, 21.0100, road="Aleje Jerozolimskie")]), None)
    res, note = run(g.search_detailed("Al. Jerozolimskie 54, Warszawa", 5))
    assert res[0].accuracy == "ADDRESS" and res[0].source == "gugik-prg"
    assert res[1].accuracy == "STREET" and note is None


def test_unmatched_building_number_is_reported_as_street_level():
    g = AddressGeocoder(FakeGugik({}), FakeNominatim([nom("Marszałkowska", 52.2418, 21.0039)]), None)
    res, note = run(g.search_detailed("Marszałkowska 100, Warszawa", 5))
    assert [r.accuracy for r in res] == ["STREET"]
    assert "Building number 100 was not matched" in note


def test_ambiguous_addresses_return_a_list_not_a_guess():
    g = AddressGeocoder(FakeGugik({"5": [item("ulica Lipowa", "5", 21.0, 52.20), item("ulica Lipowa", "5", 21.1, 52.30)]}),
                        FakeNominatim(), None)
    res, _ = run(g.search_detailed("Lipowa 5, Warszawa", 5))
    assert len(res) == 2 and {r.latitude for r in res} == {52.20, 52.30}


def test_flat_is_preserved_without_its_own_coordinates():
    building = item("ulica Puławska", "2", 21.0207, 52.2126)
    g = AddressGeocoder(FakeGugik({"2": [building]}), FakeNominatim(), None)
    res, note = run(g.search_detailed("Puławska 2 m. 15, Warszawa", 5))
    assert res[0].flat == "15" and res[0].flat_resolved is False
    assert (res[0].latitude, res[0].longitude) == (52.2126, 21.0207)  # the building point
    assert "location was not resolved" in note


def test_slash_number_falls_back_to_building_plus_flat():
    gugik = FakeGugik({"100": [item("ulica Marszałkowska", "100", 21.01, 52.23)]})
    res, _ = run(AddressGeocoder(gugik, FakeNominatim(), None).search_detailed("Marszałkowska 100/5, Warszawa", 5))
    assert gugik.calls == [("Marszałkowska", "100/5"), ("Marszałkowska", "100")]
    assert res[0].house_number == "100" and res[0].flat == "5"


def test_unregistered_letter_suffix_offers_the_base_building_labelled_as_nearby():
    # PRG has "Aleja „Solidarności” 171" but no "171B" (verified live 2026-10-18).
    gugik = FakeGugik({"171": [item("Aleja „Solidarności”", "171", 20.9789, 52.2361)]})
    g = AddressGeocoder(gugik, FakeNominatim([nom("Aleja „Solidarności”", 52.2384, 20.9838, road="Aleja „Solidarności”")]), None)
    res, note = run(g.search_detailed("Al. Solidarności 171B, 00-877 Warszawa", 5))
    assert gugik.calls == [("Aleje Solidarności", "171B"), ("Aleje Solidarności", "171")]
    assert [r.accuracy for r in res] == ["NEARBY_BUILDING", "STREET"]
    assert res[0].house_number == "171" and (res[0].latitude, res[0].longitude) == (52.2361, 20.9789)
    assert "171B is not in the official address register" in note and "building 171" in note


def test_registered_letter_suffix_is_an_exact_match_without_fallback():
    gugik = FakeGugik({"32B": [item("ulica Lipowa", "32B")], "32": [item("ulica Lipowa", "32", 21.1, 52.3)]})
    res, note = run(AddressGeocoder(gugik, FakeNominatim(), None).search_detailed("Lipowa 32B", 5))
    assert gugik.calls == [("Lipowa", "32B")] and [r.accuracy for r in res] == ["ADDRESS"] and note is None


def test_one_provider_down_still_answers_both_down_is_an_error():
    g = AddressGeocoder(FakeGugik(fail=True), FakeNominatim([nom("Marszałkowska", 52.24, 21.0)]), None)
    res, note = run(g.search_detailed("Marszałkowska 10, Warszawa", 5))
    assert res and "unavailable" in note
    with pytest.raises(GeocodingError):
        run(AddressGeocoder(FakeGugik(fail=True), FakeNominatim(fail=True), None).search_detailed("Marszałkowska 10", 5))


def test_coordinates_are_returned_as_entered():
    res, _ = run(AddressGeocoder(FakeGugik(), FakeNominatim(), None).search_detailed("52.2297, 21.0122", 5))
    assert res[0].accuracy == "COORDINATES" and (res[0].latitude, res[0].longitude) == (52.2297, 21.0122)


def test_nominatim_house_with_a_different_number_is_not_an_address_match():
    raw = nom("Marszałkowska 102", 52.23, 21.01, house="102", addresstype="building")
    r = classify_nominatim(NominatimProvider.parse([raw])[0], raw, parse_query("Marszałkowska 100"))
    assert r.accuracy == "STREET"


def test_search_endpoint_reports_parsed_query_and_accuracy(client, overrides):
    from app.dependencies import get_geocoder
    from app.services.geocoding import GeocodingService, RateLimiter, TTLCache
    g = AddressGeocoder(FakeGugik({"54": [item("Aleje Jerozolimskie", "54")]}), FakeNominatim(), None)
    overrides[get_geocoder] = lambda: GeocodingService(g, TTLCache(10, 60), RateLimiter(0, 1))
    body = client.get("/api/v1/geocoding/search", params={"query": "Al. Jerozolimskie 54 m. 7"}).json()
    assert body["parsed"] == {"street": "Aleje Jerozolimskie", "number": "54", "flat": "7", "city": None,
                              "isCoordinates": False}
    assert body["results"][0]["accuracy"] == "ADDRESS" and body["results"][0]["flatResolved"] is False


# --- entrances --------------------------------------------------------------------------------

def test_flats_ranges():
    assert flats_contain("1-20;25;30-40", "25") and flats_contain("1-20", "7")
    assert not flats_contain("1-20", "21") and not flats_contain(None, "3") and not flats_contain("1-20", None)


def _tiles(tmp_path, footprint):
    c = footprint.centroid
    x, y = tile_of(c.x, c.y)
    d = tmp_path / "14" / str(x)
    d.mkdir(parents=True)
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"id": "osm_way_1", "height_m": 18.0, "height_source": "levels_x3"},
         "geometry": mapping(footprint)}]}
    (d / f"{y}.json.gz").write_bytes(gzip.compress(json.dumps(fc).encode()))
    return tmp_path


def test_entrances_on_the_building_outline_with_flat_mapping(tmp_path):
    fp = box(21.0000, 52.2300, 21.0010, 52.2306)
    rows = [
        ["node/1", 21.0000, 52.2302, "staircase", "A", "1-20", None, None, None],  # west wall
        ["node/2", 21.0010, 52.2304, "staircase", "B", "21-40", None, None, None],  # east wall
        ["node/3", 21.0005, 52.2306, "main", None, None, None, None, "yes"],  # north wall
        ["node/9", 21.0030, 52.2303, "main", None, None, None, None, None],  # another building
    ]
    idx = EntranceIndex(True, rows, {"source": "OSM"}, _tiles(tmp_path, fp))
    out = idx.for_point(52.2303, 21.0005, flat="25")
    assert out["building"]["id"] == "osm_way_1"
    assert [e["id"] for e in out["entrances"]] == ["node/2", "node/3", "node/1"]  # flat match first
    assert out["entrances"][0]["matchesFlat"] and not out["entrances"][2]["matchesFlat"]
    assert "not a drone landing site" in out["note"]
    assert idx.for_point(52.2500, 21.0500)["entrances"] == []  # no mapped building: nothing invented


# --- route contract and time --------------------------------------------------------------------

def body(**over):
    b = {"start": A, "destination": B, "mode": "NORMAL", "flightAltitudeMeters": 80, "weatherMode": "SAMPLE"}
    b.update(over)
    return b


@pytest.mark.parametrize("opt, objective", [("FASTEST", "FASTEST"), ("SHORTEST", "SHORTEST"), ("BALANCED", "CORRIDORS")])
def test_optimization_is_applied_to_the_routing_engine(client, opt, objective):
    r = client.post(URL, json=body(optimization=opt)).json()
    assert r["status"] == "OK" and r["routeObjective"] == objective and r["optimization"] == opt


def test_optimization_validation():
    assert RouteRequest.model_validate(body(optimization="BALANCED")).route_objective == "CORRIDORS"
    with pytest.raises(ValueError, match="conflicts"):
        RouteRequest.model_validate(body(optimization="FASTEST", routeObjective="SHORTEST"))
    with pytest.raises(ValueError):
        RouteRequest.model_validate(body(optimization="QUICKEST"))


def test_standard_drone_is_the_default_profile_and_points_are_the_users(client):
    r = client.post(URL, json=body(optimization="FASTEST")).json()
    assert r["droneProfileId"] == "DEMO_DRONE_01"
    assert r["start"] == A and r["destination"] == B
    assert r["geometry"]["coordinates"][0] == [A["longitude"], A["latitude"]]


def test_calculation_time_is_set_by_the_backend_in_warsaw(client):
    r = client.post(URL, json=body()).json()
    t = datetime.fromisoformat(r["calculatedAt"])
    assert t.utcoffset().total_seconds() in (3600, 7200)
    assert abs((t - datetime.now(timezone.utc)).total_seconds()) < 60


def test_warsaw_dst_rule():
    assert warsaw_offset(datetime(2026, 1, 15, 12, tzinfo=timezone.utc)).seconds == 3600
    assert warsaw_offset(datetime(2026, 7, 15, 12, tzinfo=timezone.utc)).seconds == 7200
    assert warsaw_offset(datetime(2026, 3, 29, 0, 59, tzinfo=timezone.utc)).seconds == 3600  # last Sunday of March
    assert warsaw_offset(datetime(2026, 3, 29, 1, 0, tzinfo=timezone.utc)).seconds == 7200
    assert warsaw_offset(datetime(2026, 10, 25, 1, 0, tzinfo=timezone.utc)).seconds == 3600
    assert to_warsaw(datetime(2026, 7, 15, 10, tzinfo=timezone.utc)).hour == 12
    assert warsaw_now(datetime(2026, 1, 15, 10, tzinfo=timezone.utc)).hour == 11


# --- LIVE weather --------------------------------------------------------------------------------

def hourly(speed=20.0):
    return {"hourly": {"time": ["2026-10-18T12:00"], **{f"wind_speed_{h}m": [speed] for h in (10, 80, 120)},
                       **{f"wind_direction_{h}m": [250] for h in (10, 80, 120)}, "wind_gusts_10m": [31.0]}}


def test_live_weather_uses_open_meteo_values():
    svc = WeatherService(httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=hourly(20)))))
    w = run(svc.get(WeatherMode.LIVE, 80))
    assert w.source == WeatherSource.OPEN_METEO and w.wind_speed_kmh == 20 and w.wind_gust_kmh == 31
    assert w.observed_at.startswith("2026-10-18T12:00")  # forecast hour from the API


def test_live_failure_shows_cached_values_then_sample_fallback_explicitly():
    state = {"ok": True, "t": 0.0}

    def handler(request):
        return httpx.Response(200, json=hourly(18)) if state["ok"] else httpx.Response(503)

    svc = WeatherService(httpx.AsyncClient(transport=httpx.MockTransport(handler)), clock=lambda: state["t"])
    run(svc.get(WeatherMode.LIVE, 80))
    state.update(ok=False, t=3600.0)  # cache expired (TTL) but within the stale limit
    cached = run(svc.get(WeatherMode.LIVE, 80))
    assert cached.source == WeatherSource.CACHED and cached.wind_speed_kmh == 18 and not cached.live_available
    assert "may not reflect current conditions" in cached.message
    state["t"] = 5 * 3600.0  # too old to show
    fallback = run(svc.get(WeatherMode.LIVE, 80))
    assert fallback.source == WeatherSource.SAMPLE_FALLBACK and "NOT live data" in fallback.message
    assert fallback.mode == WeatherMode.LIVE  # never silently relabelled


def test_route_with_failed_live_weather_says_weather_is_not_current(client, overrides):
    svc = WeatherService(httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503))))
    overrides[get_weather] = lambda: svc
    r = client.post(URL, json=body(weatherMode="LIVE")).json()
    assert r["weather"]["source"] == "SAMPLE_FALLBACK"
    assert "WEATHER NOT CURRENT" in r["planningVerificationStatus"]
    assert any("NOT live data" in w for w in r["warnings"])
