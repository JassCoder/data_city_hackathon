"""Headless simulation runner (no UI, no network).

    backend/.venv/bin/python scripts/run_simulation.py data/sim_scenarios/demo_city.json
    backend/.venv/bin/python scripts/run_simulation.py data/sim_scenarios/ten_drones_hour.json \\
        --until 3600 --seed 7 --log run.jsonl --state final.json

Prints a summary per drone; --log writes the event log as JSON lines, --state the final
state as JSON. Airspace is DEMO/synthetic: a simulated flight is not a flight authorization.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.sim.engine import SIMULATION_NOTE, SimulationEngine  # noqa: E402
from app.sim.scenario import ScenarioError, load_scenario  # noqa: E402
from app.sim.world import load_world  # noqa: E402


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("scenario", type=Path)
    p.add_argument("--until", type=float, default=3600, help="simulated seconds to run (default 3600)")
    p.add_argument("--seed", type=int, default=None, help="override the scenario seed")
    p.add_argument("--log", type=Path, help="write the event log (JSON lines)")
    p.add_argument("--state", type=Path, help="write the final state (JSON)")
    p.add_argument("--keep-running", action="store_true", help="do not stop early when everything is done")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.WARNING)
    try:
        scenario = load_scenario(args.scenario)
        t0 = time.perf_counter()
        world = load_world()
        t_load = time.perf_counter() - t0
        engine = SimulationEngine.create(scenario, seed=args.seed, world=world)
    except ScenarioError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    t0 = time.perf_counter()
    state = engine.run_until(args.until, stop_when_finished=not args.keep_running)
    t_run = time.perf_counter() - t0

    counts = Counter(e["type"] for e in engine.get_event_log())
    print(f"{scenario.name}  (seed {engine.seed}, tick {engine.tick_s:g} s)")
    print(f"simulated {state['timeS']:.0f} s in {t_run:.2f} s wall clock (+{t_load:.2f} s loading the world)")
    print(f"events: {len(engine.log)}  " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    for d in state["drones"]:
        pos = d["position"]
        print(f"  {d['id']:>6} {d['name'][:22]:<22} {d['state']:<18} battery {d['batteryPct']:6.1f} %  "
              f"at {pos['latitude']:.5f}, {pos['longitude']:.5f}")
    print(SIMULATION_NOTE)
    if args.log:
        args.log.write_text(engine.log.to_jsonl() + "\n", encoding="utf-8")
        print(f"event log: {args.log}")
    if args.state:
        args.state.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"final state: {args.state}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
