import os
from pathlib import Path

from app.airspace.providers import (
    AirspaceLoadError,
    AirspaceProvider,
    CompositeProvider,
    Ed269FileProvider,
    EmptyProvider,
    GeoJsonZoneFileProvider,
)
from app.config import AIRSPACE_FILE, AIRSPACE_PROVIDER


def make_provider(kind: str = AIRSPACE_PROVIDER, file: str | None = AIRSPACE_FILE) -> AirspaceProvider:
    """No dataset is loaded by default. geojson / ed269 load official snapshot
    file(s) obtained from PAŻP with permission (see DATA_SOURCES.md). Several files
    (e.g. permanent zones + temporary restrictions) are separated by the OS path
    separator (';' on Windows, ':' elsewhere) and merged."""
    if kind in ("", "none"):
        return EmptyProvider()
    if kind in ("geojson", "ed269"):
        paths = [Path(p) for p in (file or "").split(os.pathsep) if p.strip()]
        if not paths:
            raise AirspaceLoadError(
                f"SKYROUTE_AIRSPACE_PROVIDER={kind} needs SKYROUTE_AIRSPACE_FILE=<path to the official zone file>."
            )
        cls = GeoJsonZoneFileProvider if kind == "geojson" else Ed269FileProvider
        providers: list[AirspaceProvider] = [cls(p) for p in paths]
        return providers[0] if len(providers) == 1 else CompositeProvider(providers)
    raise AirspaceLoadError(f"Unknown SKYROUTE_AIRSPACE_PROVIDER '{kind}' (use none, geojson or ed269).")
