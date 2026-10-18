from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_entrances, get_geocoder
from app.services.entrances import EntranceIndex
from app.schemas.planning import GeocodingResponse, ParsedAddressQuery
from app.services.address import parse_query
from app.services.geocoding import GeocodingBusyError, GeocodingError, GeocodingService, normalise_query

router = APIRouter(prefix="/geocoding", tags=["geocoding"])


@router.get("/search", response_model=GeocodingResponse)
async def search(
    query: Annotated[str, Query(max_length=200, description="Address or place in Warsaw")],
    geocoder: Annotated[GeocodingService, Depends(get_geocoder)],
) -> GeocodingResponse:
    q = normalise_query(query)
    parsed = parse_query(q)
    if len(q) < 3:
        raise HTTPException(422, "Enter at least 3 characters to search for an address.")
    try:
        if hasattr(geocoder, "search_detailed"):
            results, cached, note = await geocoder.search_detailed(q)
        else:  # simple geocoders (and test doubles) only implement search()
            (results, cached), note = await geocoder.search(q), None
    except GeocodingBusyError as exc:
        raise HTTPException(429, str(exc)) from exc
    except GeocodingError as exc:
        raise HTTPException(
            503, "The geocoding service is temporarily unavailable. Try again, click the map, "
            "or enter coordinates manually.",
        ) from exc
    return GeocodingResponse(
        query=q,
        results=results,
        provider=geocoder.provider.name,
        attribution=geocoder.provider.attribution,
        cached=cached,
        parsed=ParsedAddressQuery(street=parsed.street, number=parsed.number, flat=parsed.flat, city=parsed.city,
                                  is_coordinates=parsed.is_coordinates),
        note=note,
    )


@router.get("/entrances", summary="Mapped OSM entrances of the building at a point (delivery planning only)")
def entrances(
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
    index: Annotated[EntranceIndex, Depends(get_entrances)],
    flat: Annotated[str | None, Query(max_length=20, description="Flat/apartment number, if known")] = None,
) -> dict:
    return index.for_point(latitude, longitude, flat)
