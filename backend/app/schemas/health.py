from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    version: str
    mapCenter: list[float]  # [lat, lon]
    coverageAvailable: bool  # official Warsaw boundary loaded
