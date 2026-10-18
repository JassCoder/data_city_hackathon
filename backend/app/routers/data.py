from fastapi import APIRouter, Request, Response

from app.services.data_loader import Data

router = APIRouter(tags=["data"])


def get_data(request: Request) -> Data:
    return request.app.state.data


@router.get(
    "/layers",
    summary="Citywide display layers: corridors, tall buildings,  stations, building stats (zones: /zones)",
    responses={200: {"description": "`{corridors, tallBuildings, stations, buildingStats}`"}},
)
def layers(request: Request) -> Response:
    # Pre-serialised at startup; GZip middleware compresses it.
    return Response(content=get_data(request).layers_json, media_type="application/json")
