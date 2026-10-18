"""Safety vs. efficiency trade-off: one fixed order, swept over the crowd weight.

Runs the real citywide planner (SAFEST objective, real /data files, DEMO
weather, fixed departure time) once per population weight and writes a CSV with
route length, energy and population exposure. Every other weight stays as in
data/cost_model.json. Run from the repo root:

    backend/.venv/bin/python scripts/sweep_crowd_weight.py --out sweep.csv
    backend/.venv/bin/python scripts/sweep_crowd_weight.py --weights 0,1,10 \\
        --start 52.2352,21.0385 --dest 52.23,20.993

Default order: the DEMO depot -> hospital pad fixture, Delivery Drone, 80 m.
Population exposure = integral of estimated density along the route
(people/ha x km); density is an OSM-based proxy, not census data.
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.main import build_planner, load_validated_cost_model  # noqa: E402
from app.routing.costs import FlightMode, RouteObjective  # noqa: E402
from app.routing.risk.surface import CostModel  # noqa: E402
from app.services.drone_profiles import load_drone_profiles  # noqa: E402
from app.services.weather import demo_weather  # noqa: E402

DEPOT = (52.2352, 21.0385)  # st-depot (lat, lon), data/landing_stations.geojson
HOSPITAL = (52.23, 20.993)  # st-hospital
COLUMNS = ["crowd_weight", "status", "length_m", "energy_wh", "flight_time_s", "population_exposure",
           "max_density_per_ha", "total_cost", "population_cost", "message"]


def lat_lon(text: str) -> tuple[float, float]:
    lat, lon = (float(v) for v in text.split(","))
    return lat, lon


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--weights", default="0,0.5,1,2,5", help="comma-separated crowd (population) weights")
    p.add_argument("--start", type=lat_lon, default=DEPOT, help="lat,lon")
    p.add_argument("--dest", type=lat_lon, default=HOSPITAL, help="lat,lon")
    p.add_argument("--profile", default="DEMO_DRONE_02")
    p.add_argument("--altitude", type=int, default=None, help="metres AGL (default: cost model defaultCruiseM)")
    p.add_argument("--payload", type=float, default=None, help="kg (default: cost model defaultPayloadKg)")
    p.add_argument("--departure", default="2026-10-17T12:00", help="local time in the cost model's timezone")
    p.add_argument("--out", type=Path, default=None, help="CSV file (default: stdout)")
    return p.parse_args(argv)


def sweep(args) -> list[dict]:
    cfg = load_validated_cost_model()
    planner = build_planner(cfg)
    profile = load_drone_profiles().get(args.profile)
    if profile is None:
        raise SystemExit(f"Unknown profile {args.profile}")
    altitude = args.altitude or int(cfg.altitude.default_cruise_m)
    at = datetime.fromisoformat(args.departure).replace(tzinfo=ZoneInfo(cfg.timezone))
    start, dest = (args.start[1], args.start[0]), (args.dest[1], args.dest[0])
    weather = demo_weather(altitude)
    base = planner.risk
    rows = []
    for w in (float(v) for v in args.weights.split(",")):
        weighted = cfg.model_copy(update={"weights": cfg.weights.model_copy(update={"population": w})})
        planner.risk = CostModel(weighted, base.spec, base.providers)
        r = planner.plan(start, dest, FlightMode.NORMAL, altitude, profile, weather, at, RouteObjective.SAFEST,
                         args.payload)
        b = r.breakdown
        rows.append({
            "crowd_weight": w, "status": r.status.value,
            "length_m": round(b.length_m, 1) if b else "",
            "energy_wh": round(b.energy_wh, 2) if b else "",
            "flight_time_s": round(b.flight_time_s, 1) if b else "",
            "population_exposure": round(b.population_exposure, 2) if b else "",
            "max_density_per_ha": round(b.max_density_per_ha, 1) if b else "",
            "total_cost": round(b.total_cost, 1) if b else "",
            "population_cost": round(b.terms["population"].cost, 1) if b else "",
            "message": r.message,
        })
        print(f"weight {w:g}: {r.status.value} {rows[-1]['length_m']} m, exposure {rows[-1]['population_exposure']}",
              file=sys.stderr)
    return rows


def main(argv=None) -> int:
    args = parse_args(argv)
    rows = sweep(args)
    out = open(args.out, "w", newline="", encoding="utf-8") if args.out else sys.stdout
    try:
        writer = csv.DictWriter(out, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    finally:
        if args.out:
            out.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
