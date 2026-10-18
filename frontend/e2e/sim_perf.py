"""Simulation view frame rate: 20 drones at 60x (dev tool; needs backend :8000 and ng serve :4200).

    backend/.venv/bin/python frontend/e2e/sim_perf.py [--seconds 20] [--cpu-throttle 4] [--headed]

Counts requestAnimationFrame callbacks in the page while the twenty_drones scenario plays at
60x, zoomed to street level so name tags, battery bars, routes and trails are all drawn
(the expensive case). Reports average fps, the 5th-percentile fps (from the 95th-percentile
frame time), frames slower than 50 ms and long tasks.
"""

from __future__ import annotations

import argparse
import statistics

from playwright.sync_api import expect, sync_playwright

URL = "http://localhost:4200/simulate"

MEASURE = """
async (ms) => {
  const times = [];
  const flying = [];
  let longTasks = 0;
  const sampler = setInterval(() => flying.push(document.querySelectorAll('.sim-drone:not(.ground)').length), 250);
  const obs = new PerformanceObserver((l) => (longTasks += l.getEntries().length));
  try { obs.observe({ entryTypes: ['longtask'] }); } catch {}
  await new Promise((done) => {
    let last = performance.now();
    const end = last + ms;
    const tick = (now) => {
      times.push(now - last);
      last = now;
      if (now < end) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  obs.disconnect();
  clearInterval(sampler);
  return { times, longTasks, flying };
}
"""


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--seconds", type=float, default=10)
    p.add_argument("--cpu-throttle", type=float, default=1, help="Chrome CPU slowdown factor (1 = none)")
    p.add_argument("--headed", action="store_true")
    args = p.parse_args()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=not args.headed)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        if args.cpu_throttle > 1:
            cdp = page.context.new_cdp_session(page)
            cdp.send("Emulation.setCPUThrottlingRate", {"rate": args.cpu_throttle})
        page.goto(URL)
        page.get_by_test_id("scenario-twenty_drones").click()
        page.get_by_test_id("sim-start-btn").click()
        expect(page.get_by_test_id("playback-bar")).to_be_visible()
        for _ in range(3):  # street level over central Warsaw: tags and battery bars visible
            page.locator(".leaflet-control-zoom-in").click()
            page.wait_for_timeout(350)
        page.get_by_label("60 times real time").check()
        page.evaluate("document.activeElement.blur()")
        page.keyboard.press("Space")
        page.wait_for_timeout(2000)  # warm-up: the first wave takes off (loading takes 60 s)
        t0 = page.get_by_test_id("sim-clock").inner_text().split("\n")[-1]
        result = page.evaluate(MEASURE, args.seconds * 1000)
        t1 = page.get_by_test_id("sim-clock").inner_text().split("\n")[-1]
        tags = page.locator(".sim-drone .sd-tag:visible").count()
        browser.close()

    times = result["times"][1:]
    avg_fps = len(times) / (sum(times) / 1000)
    p95 = statistics.quantiles(times, n=20)[18]
    slow = sum(t > 50 for t in times)
    print(f"20 drones at 60x, {args.seconds:g} s measured, CPU throttle {args.cpu_throttle:g}x, "
          f"{'headed' if args.headed else 'headless'} Chrome")
    fl = result["flying"]
    print(f"simulated {t0} -> {t1}; drones in the air while measuring: max {max(fl)}, "
          f"mean {statistics.mean(fl):.1f}; {tags} name tags visible")
    print(f"average {avg_fps:.1f} fps; 95th-percentile frame {p95:.1f} ms (= {1000 / p95:.0f} fps); "
          f"max frame {max(times):.0f} ms; frames > 50 ms: {slow}; long tasks: {result['longTasks']}")
    if errors:
        print("page errors:", errors[:3])
    return 0 if avg_fps >= 30 and not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
