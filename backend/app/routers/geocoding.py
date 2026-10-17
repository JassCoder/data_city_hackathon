from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_geocoder
from app.schemas.planning import GeocodingResponse
from app.services.geocoding import GeocodingBusyError, GeocodingError, GeocodingService, normalise_query

router = APIRouter(prefix="/geocoding", tags=["geocoding"])


@router.get("/search", response_model=GeocodingResponse)
async def search(
    query: Annotated[str, Query(max_length=200, description="Address or place in Warsaw")],
    geocoder: Annotated[GeocodingService, Depends(get_geocoder)],
) -> GeocodingResponse:
    q = normalise_query(query)
    if len(q) < 3:
        raise HTTPException(422, "Enter at least 3 characters to search for an address.")
    try:
        results, cached = await geocoder.search(q)
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
    )
