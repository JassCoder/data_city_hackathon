from fastapi import APIRouter

from app.config import APP_VERSION, DEMO_BBOX, MAP_CENTER
from app.schemas.health import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        version=APP_VERSION,
        mapCenter=list(MAP_CENTER),
        demoBbox=DEMO_BBOX,
    )
