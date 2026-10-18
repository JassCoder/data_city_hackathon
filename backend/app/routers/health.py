from fastapi import APIRouter, Request

from app.config import APP_VERSION, MAP_CENTER
from app.schemas.health import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    planner = getattr(request.app.state, "planner", None)
    return HealthResponse(
        status="ok",
        version=APP_VERSION,
        mapCenter=list(MAP_CENTER),
        coverageAvailable=bool(planner and planner.coverage.available),
        riskDataAvailable=bool(planner and planner.risk.data_available),
    )
