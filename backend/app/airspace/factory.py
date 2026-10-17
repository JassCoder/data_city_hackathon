from pathlib import Path

from app.airspace.providers import AirspaceLoadError, AirspaceProvider, Ed269FileProvider, GeoJsonZoneFileProvider
from app.config import AIRSPACE_DEMO_FILE, AIRSPACE_FILE, AIRSPACE_PROVIDER


def make_provider(kind: str = AIRSPACE_PROVIDER, file: str | None = AIRSPACE_FILE) -> AirspaceProvider:
    """demo: bundled synthetic zones. geojson / ed269: an official snapshot file
    obtained from PAŻP with permission (see DATA_SOURCES.md)."""
    if kind == "demo":
        return GeoJsonZoneFileProvider(AIRSPACE_DEMO_FILE)
    if kind in ("geojson", "ed269"):
        if not file:
            raise AirspaceLoadError(
                f"SKYROUTE_AIRSPACE_PROVIDER={kind} needs SKYROUTE_AIRSPACE_FILE=<path to the official zone file>."
            )
        path = Path(file)
        return GeoJsonZoneFileProvider(path) if kind == "geojson" else Ed269FileProvider(path)
    raise AirspaceLoadError(f"Unknown SKYROUTE_AIRSPACE_PROVIDER '{kind}' (use demo, geojson or ed269).")
