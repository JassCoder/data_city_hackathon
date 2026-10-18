"""Browser check for the SkyRoute UI: screenshots + overlay-overlap assertions.

Drives the locally installed Google Chrome through Python Playwright (dev tool,
installed in backend/.venv only). Needs the backend (8000) and `ng serve` (4200)
running, or wrap with .claude/skills/webapp-testing/scripts/with_server.py.

    backend/.venv/bin/python frontend/e2e/ui_check.py --out /tmp/shots --label step1

Checks at 1280x720 and 390x844, in the default state and with the Layers panel
and legend open: no two map overlays (Leaflet controls, [data-overlay]) intersect,
and none covers the zoom control. Exit code 1 on any overlap.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

VIEWPORTS = {"desktop": (1280, 720), "mobile": (390, 844)}
OVERLAYS = ".leaflet-control, [data-overlay]"


def boxes(page: Page) -> list[dict]:
    """Visible overlay boxes with a short description."""
    return page.evaluate(
        """(sel) => [...document.querySelectorAll(sel)]
            .filter(el => !el.parentElement.closest('[data-overlay]'))
            .map(el => {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return {name: (el.getAttribute('data-overlay') || el.className.toString()).slice(0, 60),
                      x: r.x, y: r.y, w: r.width, h: r.height,
                      visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'};
            }).filter(b => b.visible)""",
        OVERLAYS,
    )


def intersect(a: dict, b: dict, tol: float = 0.5) -> bool:
    return (a["x"] + tol < b["x"] + b["w"] and b["x"] + tol < a["x"] + a["w"]
            and a["y"] + tol < b["y"] + b["h"] and b["y"] + tol < a["y"] + a["h"])


def overlaps(page: Page) -> list[str]:
    found = []
    items = boxes(page)
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            if intersect(a, b):
                found.append(f"{a['name']!r} overlaps {b['name']!r}")
    return found


def open_overlays(page: Page) -> None:
    """Expand the Layers panel and the legend if the UI has toggles for them."""
    for testid in ("layers-toggle", "legend-toggle"):
        el = page.locator(f'[data-testid="{testid}"]')
        if el.count() and el.first.is_visible():
            el.first.click()
    page.wait_for_timeout(300)


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:4200")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--label", default="check")
    args = p.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        for name, (w, h) in VIEWPORTS.items():
            page = browser.new_page(viewport={"width": w, "height": h})
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(args.url)
            page.wait_for_load_state("networkidle")
            page.wait_for_selector(".leaflet-container")
            page.wait_for_timeout(800)  # canvas layers redraw on animation frames
            page.screenshot(path=args.out / f"{args.label}-{name}.png")
            problems += [f"[{name} default] {o}" for o in overlaps(page)]
            open_overlays(page)
            page.screenshot(path=args.out / f"{args.label}-{name}-open.png")
            problems += [f"[{name} open] {o}" for o in overlaps(page)]
            problems += [f"[{name}] page error: {e}" for e in errors]
            page.close()
        browser.close()
    for line in problems:
        print("FAIL", line)
    print(f"{len(problems)} problem(s); screenshots in {args.out}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
