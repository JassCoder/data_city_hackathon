"""Address parsing and building-level geocoding.

`AddressGeocoder` combines interchangeable providers:
- `GugikAddressProvider`: official GUGiK PRG address points (open data) through the
  public GUGiK geocoding service (UUG). Exact building numbers only; every result is
  re-checked against the requested street, because the service's fuzzy street match
  can return a different street (e.g. "Nowa" for "Nowy Świat"), and a wrong building
  must never be chosen silently.
- `NominatimProvider` (OpenStreetMap): places and a fallback, rate-limited.

Every result carries an accuracy level: ADDRESS (building/address matched),
STREET (street-level approximation), PLACE (place-level) or COORDINATES. A flat /
apartment number is preserved in the result but never gets coordinates of its own.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from enum import StrEnum

import httpx

from app.schemas.planning import GeocodeResult
from app.services.geocoding import ContainsFn, GeocodingError, RateLimiter, _never


class Accuracy(StrEnum):
    ADDRESS = "ADDRESS"  # building / address point matched (incl. the building number)
    NEARBY_BUILDING = "NEARBY_BUILDING"  # "171B" not registered: the base building "171" on the same street
    STREET = "STREET"  # street-level approximation
    PLACE = "PLACE"  # place-level approximation
    COORDINATES = "COORDINATES"  # entered as latitude/longitude


ACCURACY_RANK = {Accuracy.COORDINATES: 0, Accuracy.ADDRESS: 1, Accuracy.NEARBY_BUILDING: 2, Accuracy.STREET: 3,
                 Accuracy.PLACE: 4}
_LETTER_SUFFIX = re.compile(r"^(\d+)[A-Z]$")

_COORDS = re.compile(r"^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$")
# street + building number (e.g. 32/34A) + optional flat ("m. 5", "lok 5", "apt 5")
_ADDRESS = re.compile(
    r"^(?P<street>.*?[^\W\d_].*?)\s+(?P<number>\d+[A-Za-z]?(?:\s*/\s*\d+[A-Za-z]?)?)"
    r"(?:\s*(?:m\.?|lok\.?|lokal|apt\.?|mieszk\.?|flat)\s*(?P<flat>[\w-]+))?\s*$",
    re.IGNORECASE,
)
_PREFIXES = {"ul": "", "ulica": "", "al": "Aleje", "aleja": "Aleja", "aleje": "Aleje", "pl": "Plac", "plac": "Plac",
             "os": "Osiedle", "osiedle": "Osiedle", "rondo": "Rondo"}
_STOPWORDS = {"ulica", "ul", "aleja", "aleje", "al", "plac", "pl", "osiedle", "os", "rondo", "i", "w", "im"}
CITY = "Warszawa"


@dataclass(frozen=True)
class ParsedQuery:
    raw: str
    street: str | None = None
    number: str | None = None
    flat: str | None = None
    city: str | None = None
    latitude: float | None = None
    longitude: float | None = None

    @property
    def is_coordinates(self) -> bool:
        return self.latitude is not None


def _fold(s: str) -> str:
    """lower-case, accents removed (ł -> l), punctuation to spaces."""
    s = s.lower().replace("ł", "l")
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def street_tokens(street: str) -> set[str]:
    return {t for t in _fold(street).split() if t not in _STOPWORDS and len(t) > 1}


def same_street(requested: str, returned: str) -> bool:
    """Every significant word of the requested street must appear in the returned one."""
    want, got = street_tokens(requested), street_tokens(returned)
    return bool(want) and want <= got


def normalise_number(n: str) -> str:
    return re.sub(r"\s+", "", n).upper()


def _clean_street(street: str) -> str:
    words = street.strip().rstrip(",").split()
    if words and words[0].lower().rstrip(".") in _PREFIXES:
        head = _PREFIXES[words[0].lower().rstrip(".")]
        words = ([head] if head else []) + words[1:]
    return " ".join(words)


def parse_query(query: str) -> ParsedQuery:
    """Recognises 'lat, lon', or '<street> <number>[/<n>] [m. <flat>][, <city>]'."""
    q = re.sub(r"\s+", " ", query).strip()
    m = _COORDS.match(q)
    if m:
        a, b = float(m.group(1)), float(m.group(2))
        if -90 <= a <= 90 and -180 <= b <= 180:
            return ParsedQuery(q, latitude=a, longitude=b)
    parts = [p.strip() for p in q.split(",") if p.strip()]
    city = None
    if len(parts) > 1:
        tail = re.sub(r"^\d{2}-\d{3}\s*", "", parts[-1])  # "00-001 Warszawa" -> "Warszawa"
        if tail and not re.search(r"\d", tail):
            city, parts = tail, parts[:-1]
    main = ", ".join(parts)
    m = _ADDRESS.match(main)
    if not m:
        return ParsedQuery(q, city=city)
    return ParsedQuery(q, street=_clean_street(m.group("street")), number=normalise_number(m.group("number")),
                       flat=m.group("flat"), city=city)


def _distance_m(a: GeocodeResult, b: GeocodeResult) -> float:
    dy = (a.latitude - b.latitude) * 111_320
    dx = (a.longitude - b.longitude) * 111_320 * math.cos(math.radians(a.latitude))
    return math.hypot(dx, dy)


class GugikAddressProvider:
    """GUGiK geocoding service (UUG) over the official PRG address points."""

    name = "gugik-uug"
    attribution = "Address points: GUGiK – Państwowy Rejestr Granic (PRG), via the GUGiK geocoding service (UUG)"

    def __init__(self, client: httpx.AsyncClient, url: str, user_agent: str, contains: ContainsFn = _never,
                 limiter: RateLimiter | None = None, timeout_s: float = 8.0):
        self._client, self._url, self._ua = client, url, user_agent
        self._contains, self._limiter, self._timeout = contains, limiter, timeout_s

    async def lookup(self, street: str, number: str, city: str = CITY) -> list[GeocodeResult]:
        if self._limiter:
            await self._limiter.acquire()
        try:
            res = await self._client.get(self._url, params={"request": "GetAddress", "address": f"{city}, {street} {number}",
                                                            "srid": "4326"},
                                         headers={"User-Agent": self._ua}, timeout=self._timeout)
            res.raise_for_status()
            payload = res.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise GeocodingError(f"GUGiK geocoding failed: {type(exc).__name__}") from exc
        return self.parse(payload, street, number, self._contains)

    @staticmethod
    def parse(payload: object, street: str, number: str, contains: ContainsFn = _never) -> list[GeocodeResult]:
        if not isinstance(payload, dict):
            raise GeocodingError("GUGiK returned an unexpected payload")
        out = []
        for item in (payload.get("results") or {}).values():
            try:
                lon, lat = float(item["x"]), float(item["y"])
                got_street, got_number = str(item.get("street") or ""), normalise_number(str(item["number"]))
            except (KeyError, TypeError, ValueError):
                continue
            # Exact building number on the requested street only; anything else is rejected.
            if got_number != normalise_number(number) or not same_street(street, got_street or str(item.get("city", ""))):
                continue
            label = f"{got_street} {item['number']}".strip()
            post = " ".join(p for p in (item.get("code"), item.get("city")) if p)
            out.append(GeocodeResult(
                display_name=f"{label}, {post}" if post else label, latitude=lat, longitude=lon,
                place_id=f"prg:{item.get('teryt', '')}:{item.get('ulic', '')}:{got_number}", category="address/prg",
                source="gugik-prg", in_coverage=contains(lon, lat), accuracy=Accuracy.ADDRESS.value,
                street=got_street or None, house_number=str(item["number"]), postcode=item.get("code"),
            ))
        return out


def classify_nominatim(r: GeocodeResult, raw: dict, parsed: ParsedQuery) -> GeocodeResult:
    """Accuracy of a Nominatim result for the parsed query."""
    addr = raw.get("address") or {}
    house = addr.get("house_number")
    kind = raw.get("addresstype") or raw.get("type") or ""
    road = addr.get("road") or addr.get("pedestrian") or addr.get("square")
    if house and (not parsed.number or normalise_number(house) == parsed.number) and (
            not parsed.street or not road or same_street(parsed.street, road)):
        acc = Accuracy.ADDRESS
    elif kind in ("road", "street", "highway") or raw.get("category") == "highway" or (parsed.number and road):
        acc = Accuracy.STREET
    else:
        acc = Accuracy.PLACE
    return r.model_copy(update={"accuracy": acc.value, "street": road, "house_number": house,
                                "postcode": addr.get("postcode")})


class AddressGeocoder:
    """GUGiK PRG for building numbers, Nominatim for places/fallback; one ranked list."""

    name = "gugik-prg+nominatim"
    supports_autocomplete = False

    def __init__(self, gugik: GugikAddressProvider | None, nominatim, nominatim_limiter: RateLimiter | None,
                 contains: ContainsFn = _never):
        self.gugik, self.nominatim, self._limiter, self._contains = gugik, nominatim, nominatim_limiter, contains
        parts = [getattr(p, "attribution", type(p).__name__) for p in (gugik, nominatim) if p is not None]
        self.attribution = " · ".join(parts)

    async def search(self, query: str, limit: int) -> list[GeocodeResult]:
        results, _ = await self.search_detailed(query, limit)
        return results

    async def search_detailed(self, query: str, limit: int) -> tuple[list[GeocodeResult], str | None]:
        parsed = parse_query(query)
        if parsed.is_coordinates:
            lat, lon = parsed.latitude, parsed.longitude
            return [GeocodeResult(display_name=f"{lat:.6f}, {lon:.6f}", latitude=lat, longitude=lon, place_id=None,
                                  category="coordinates", source="input", in_coverage=self._contains(lon, lat),
                                  accuracy=Accuracy.COORDINATES.value)], None
        found: list[GeocodeResult] = []
        flat = parsed.flat
        errors: list[str] = []
        if self.gugik and parsed.street and parsed.number:
            try:
                found = await self.gugik.lookup(parsed.street, parsed.number, parsed.city or CITY)
                if not found and "/" in parsed.number and not flat:
                    # "100/5" may be building 100, flat 5 (while "32/34A" is a building number).
                    building, maybe_flat = parsed.number.split("/", 1)
                    found = await self.gugik.lookup(parsed.street, building, parsed.city or CITY)
                    if found:
                        flat = maybe_flat
                base = _LETTER_SUFFIX.match(parsed.number)
                if not found and base:
                    # "171B" is not registered: offer the registered base building "171" on the same
                    # street, labelled as such (never as an exact match).
                    found = [r.model_copy(update={"accuracy": Accuracy.NEARBY_BUILDING.value})
                             for r in await self.gugik.lookup(parsed.street, base.group(1), parsed.city or CITY)]
            except GeocodingError as exc:
                errors.append(str(exc))
        if self.nominatim is not None:
            try:
                if self._limiter:
                    await self._limiter.acquire()
                for raw, r in await self.nominatim.search_raw(query, limit):
                    found.append(classify_nominatim(r, raw, parsed))
            except GeocodingError as exc:
                errors.append(str(exc))
        if not found and errors:
            raise GeocodingError("; ".join(errors))
        ranked = self._rank(found)[:limit]
        if flat:
            ranked = [r.model_copy(update={"flat": flat, "flat_resolved": False}) for r in ranked]
        return ranked, self._note(parsed, ranked, flat, errors)

    @staticmethod
    def _rank(results: list[GeocodeResult]) -> list[GeocodeResult]:
        ordered = sorted(enumerate(results), key=lambda ir: (ACCURACY_RANK[Accuracy(ir[1].accuracy)],
                                                              ir[1].source != "gugik-prg", ir[0]))
        kept: list[GeocodeResult] = []
        for _, r in ordered:  # drop near-duplicates (same place from both providers)
            if not any(k.accuracy == r.accuracy and _distance_m(k, r) < 15 for k in kept):
                kept.append(r)
        return kept

    @staticmethod
    def _note(parsed: ParsedQuery, results: list[GeocodeResult], flat: str | None, errors: list[str]) -> str | None:
        notes = []
        nearby = next((r for r in results if r.accuracy == Accuracy.NEARBY_BUILDING.value), None)
        if parsed.number and nearby and not any(r.accuracy == Accuracy.ADDRESS.value for r in results):
            notes.append(f"Building number {parsed.number} is not in the official address register (PRG); the "
                         f"registered building {nearby.house_number} on the same street is used instead.")
        elif parsed.number and not any(r.accuracy == Accuracy.ADDRESS.value for r in results):
            notes.append(f"Building number {parsed.number} was not matched; results are street- or place-level "
                         "approximations.")
        if flat:
            notes.append(f"Flat/apartment {flat} is kept with the address, but its location was not resolved: the "
                         "point is the building.")
        if errors and results:
            notes.append("One address source was unavailable; results may be less precise.")
        return " ".join(notes) or None
