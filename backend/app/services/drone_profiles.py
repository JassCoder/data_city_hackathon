"""Sample drone profiles from data/drone_profiles.json (single source of truth;
the frontend reads them from GET /drone-profiles)."""

import json
from pathlib import Path

from pydantic import ValidationError

from app.config import DATA_DIR, DRONE_PROFILES_FILE
from app.schemas.planning import DroneProfile, DroneProfilesResponse
from app.services.data_loader import DataLoadError


class DroneProfileRegistry:
    def __init__(self, profiles: list[DroneProfile], disclaimer: str):
        self._by_id = {p.id: p for p in profiles}
        self.response = DroneProfilesResponse(profiles=profiles, disclaimer=disclaimer)

    def get(self, profile_id: str) -> DroneProfile | None:
        return self._by_id.get(profile_id)

    @property
    def ids(self) -> list[str]:
        return list(self._by_id)


def load_drone_profiles(data_dir: Path = DATA_DIR) -> DroneProfileRegistry:
    path = data_dir / DRONE_PROFILES_FILE
    if not path.is_file():
        raise DataLoadError(f"Missing data file {path}.")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        profiles = [DroneProfile.model_validate(p) for p in raw["profiles"]]
    except (json.JSONDecodeError, KeyError, ValidationError) as exc:
        raise DataLoadError(f"Invalid {path.name}:\n{exc}") from exc
    if len({p.id for p in profiles}) != len(profiles):
        raise DataLoadError(f"{path.name}: duplicate profile ids")
    return DroneProfileRegistry(profiles, raw.get("disclaimer", ""))
