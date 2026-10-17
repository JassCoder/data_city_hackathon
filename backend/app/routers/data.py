from fastapi import APIRouter, Request, Response

from app.services.data_loader import DemoData

router = APIRouter(tags=["data"])


def get_data(request: Request) -> DemoData:
    return request.app.state.data


@router.get(
    "/layers",
    summary="Demo bbox plus corridors, buildings and stations as GeoJSON (zones: /zones)",
    responses={200: {"description": "`{bbox, corridors, buildings, stations}`"}},
)
def layers(request: Request) -> Response:
    # Pre-serialised at startup; GZip middleware compresses it.
    return Response(content=get_data(request).layers_json, media_type="application/json")
