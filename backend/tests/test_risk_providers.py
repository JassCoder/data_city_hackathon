from datetime import datetime, timezone

import numpy as np
import pytest

from app.routing.risk.providers import (
    CostContext,
    GridSpec,
    LandUseProvider,
    ObstacleProvider,
    PopulationDensityProvider,
    SampledWind,
    WindProvider,
)
from app.routing.risk.synthetic import synthetic_world

SPEC = GridSpec(10, 12, 25.0)
CTX = CostContext(datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc), 80, 0.0)


def test_synthetic_world_satisfies_every_protocol():
    w = synthetic_world(SPEC)
    assert isinstance(w.population, PopulationDensityProvider)
    assert isinstance(w.land_use, LandUseProvider)
    assert isinstance(w.obstacles, ObstacleProvider)
    assert isinstance(w.wind, WindProvider)


def test_synthetic_world_places_blocks():
    block = (slice(2, 5), slice(3, 6))
    w = synthetic_world(SPEC, crowded=[(block, 400.0)], buildings=[(block, 40.0)], sensitive=[block],
                        residential=[block], open_space=[(slice(0, 1), slice(0, 1))], wind=(20.0, 270.0))
    d = w.population.density_per_ha()
    assert d.shape == SPEC.shape and d[3, 4] == 400 and d[0, 0] == 0 and d[block].sum() == 400 * 9
    assert w.obstacles.heights_m()[2, 3] == 40
    assert w.land_use.sensitive_sites()[block].all() and w.land_use.residential_share()[4, 5] == 1.0
    assert w.land_use.open_space().sum() == 1  # explicit blocks replace "open everywhere"
    (s,) = w.wind.samples(CTX)
    assert (s.speed_kmh, s.direction_deg) == (20.0, 270.0)


def test_grid_spec_rejects_mismatched_rasters():
    with pytest.raises(ValueError, match="does not match"):
        SPEC.check("density", np.zeros((3, 3)))


def test_local_hour_uses_the_configured_timezone():
    # 23:30 UTC on 17 Oct is 01:30 in Warsaw (CEST, UTC+2): night, not evening.
    ctx = CostContext(datetime(2026, 10, 17, 23, 30, tzinfo=timezone.utc), 80, 0.0)
    assert ctx.local_hour("Europe/Warsaw") == 1
    naive = CostContext(datetime(2026, 10, 17, 23, 30), 80, 0.0)  # treated as UTC
    assert naive.local_hour("Europe/Warsaw") == 1


def test_sampled_wind_needs_a_sample():
    with pytest.raises(ValueError):
        SampledWind([])
