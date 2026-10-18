"""End-to-end flows for the acceptance criteria (Playwright + system Chrome).

Needs the backend (8000) and `ng serve` (4200). Run from the repo root:

    backend/.venv/bin/python frontend/e2e/flows.py --out /tmp/shots

1. no overlay overlaps another or the zoom control (with routes + drawer open, both sizes)
2. A/B via suggestion, typed coordinates, map pick (Esc cancels) and marker drag
3. three drones with three differently coloured routes at once
4. clicking a zone explains what it means for the selected flight
5. a failing request for one drone leaves the others untouched
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ui_check import overlaps  # noqa: E402

URL = "http://localhost:4200"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" ({detail})" if detail else ""), flush=True)


def settled(page: Page, timeout: int = 60000) -> None:
    """Wait until there are drones and none is calculating."""
    page.wait_for_selector("li.drone")
    page.wait_for_function(
        "() => ![...document.querySelectorAll('[data-testid=drone-status]')].some(e => e.textContent.includes('Calculating'))",
        timeout=timeout,
    )


def calculate(page: Page, click) -> None:
    """Click something that starts calculations, wait for them to start, then to finish."""
    click()
    try:
        page.wait_for_function(
            "() => [...document.querySelectorAll('[data-testid=drone-status]')].some(e => e.textContent.includes('Calculating'))",
            timeout=5000,
        )
    except Exception:
        pass  # already finished (cached on the server)
    settled(page)


def has_value(locator, pattern: str) -> bool:
    try:
        expect(locator).to_have_value(re.compile(pattern), timeout=3000)
        return True
    except AssertionError:
        return False


def visible(locator) -> bool:
    try:
        expect(locator).to_be_visible(timeout=3000)
        return True
    except AssertionError:
        return False


def fresh(page: Page, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".zone-glyph")


def route_colors(page: Page) -> list[str]:
    return page.eval_on_selector_all(
        "path.route-line.route-ready", "els => [...new Set(els.map(e => e.getAttribute('stroke')))]"
    )


def desktop(page: Page, out: Path) -> None:
    fresh(page, 1280, 720)

    # --- 3 drones, 3 colours -------------------------------------------------------
    page.get_by_test_id("load-demo").first.click()
    settled(page)
    drones = page.locator("li.drone")
    check("demo fleet adds 3 drones", drones.count() == 3, str(drones.count()))
    statuses = page.locator("[data-testid=drone-status]").all_inner_texts()
    check("courtyard at 20 m has no feasible route", "No feasible route" in statuses[2], str(statuses))
    # Raise the courtyard drone to 80 m: now all three fly.
    drones.nth(2).get_by_test_id("drone-edit").click()
    num = page.get_by_test_id("altitude-number")
    num.fill("80")
    num.dispatch_event("input")
    calculate(page, lambda: page.get_by_test_id("calculate").click())
    page.get_by_test_id("done").click()
    page.wait_for_timeout(300)
    colors = route_colors(page)
    check("three differently coloured routes at once", len(colors) >= 3, str(colors))
    page.screenshot(path=out / "flow-desktop-fleet.png")

    # --- route details drawer -------------------------------------------------------
    drones.nth(1).get_by_test_id("drone-select").click()
    expect(page.get_by_test_id("drawer")).not_to_have_attribute("inert", "")
    headline = page.get_by_test_id("details-headline").inner_text()
    check("drawer shows the selected drone's result", "Route ready" in headline, headline)
    check("drawer lists the avoided zone", page.get_by_test_id("details-zones").count() == 1)
    check("drawer keeps the safety note", "not a flight authorization" in page.get_by_test_id("details-safety").inner_text())
    found = overlaps(page)
    check("no overlaps with routes and drawer open (desktop)", not found, "; ".join(found))
    page.screenshot(path=out / "flow-desktop-drawer.png")

    # --- add a drone: suggestion, coordinates, pick + Esc, drag -----------------------
    page.get_by_test_id("add-drone").click()
    editor = page.get_by_test_id("drone-editor")
    a = editor.get_by_test_id("point-start").get_by_test_id("point-input")
    a.fill("srodm")
    page.get_by_test_id("suggestion").first.click()
    check("point A set from a local suggestion", has_value(a, "Śródmieście"), a.input_value())
    b = editor.get_by_test_id("point-destination").get_by_test_id("point-input")
    b.fill("52.2397, 21.0454")
    b.press("Enter")
    check("point B set from typed coordinates", has_value(b, r"^Coordinates 52\.23970"), b.input_value())
    editor.get_by_test_id("point-destination").get_by_test_id("pick").click()
    check("pick mode shows a hint", visible(page.get_by_test_id("pick-hint")))
    page.keyboard.press("Escape")
    expect(page.get_by_test_id("pick-hint")).to_have_count(0, timeout=3000)
    check("Escape cancels pick mode", page.get_by_test_id("pick-hint").count() == 0)
    editor.get_by_test_id("point-destination").get_by_test_id("pick").click()
    expect(page.get_by_test_id("pick-hint")).to_be_visible()
    box = page.locator(".leaflet-container").bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.62, box["y"] + box["height"] * 0.42)
    check("map click sets point B", has_value(b, "^Map point"), b.input_value())
    # Back to a known destination (Stadion Narodowy) so the route, fit and drag are deterministic.
    b.fill("52.2397, 21.0454")
    b.press("Enter")
    expect(b).to_have_value(re.compile("^Coordinates"))
    calculate(page, lambda: page.get_by_test_id("calculate").click())
    status = page.locator("li.drone").nth(3).get_by_test_id("drone-status")
    check("the new drone gets a route", status.inner_text() == "Route ready", status.inner_text())
    pin = page.locator(".route-pin.selected").first  # Point A: on the hospital pad, stacked with a station
    pb = pin.bounding_box()
    page.mouse.move(pb["x"] + pb["width"] / 2, pb["y"] + pb["height"] / 2)
    page.mouse.down()
    page.mouse.move(pb["x"] + 60, pb["y"] + 30, steps=8)
    page.mouse.up()
    try:
        expect(status).to_have_text("Outdated", timeout=3000)
    except AssertionError:
        pass
    check("dragging a marker invalidates the route", status.inner_text() == "Outdated", status.inner_text())

    # --- zone popup -----------------------------------------------------------------
    page.get_by_test_id("done").click()
    page.locator("li.drone").nth(1).get_by_test_id("drone-select").click()
    expect(page.locator("li.drone.selected")).to_contain_text("Across the Sejm zone")
    page.wait_for_timeout(300)
    zone = page.locator('.leaflet-zone-pane path[fill="url(#zp-prohibited)"]').first
    zb = zone.bounding_box()
    page.mouse.click(zb["x"] + zb["width"] * 0.5, zb["y"] + zb["height"] * 0.4)
    page.wait_for_selector(".zone-popup")
    text = page.locator(".zone-popup").inner_text()
    check("zone popup explains it for the selected flight", "For Across the Sejm zone at 80 m AGL" in text and "Blocked" in text, text[:120])
    page.screenshot(path=out / "flow-desktop-zone.png")

    # --- one failing drone ----------------------------------------------------------
    def fail_sejm(route):
        body = json.loads(route.request.post_data or "{}")
        if abs(body.get("start", {}).get("longitude", 0) - 21.0205) < 1e-6:
            route.fulfill(status=500, body=json.dumps({"detail": "Simulated server failure"}), content_type="application/json")
        else:
            route.continue_()

    page.route("**/routes/calculate", fail_sejm)
    calculate(page, lambda: page.get_by_test_id("calculate-all").click())
    statuses = page.locator("[data-testid=drone-status]").all_inner_texts()
    check("one failure stays on its drone", statuses[1] == "Error" and statuses[0] == "Route ready" and statuses[2] == "Route ready", str(statuses))
    page.unroute("**/routes/calculate")
    page.screenshot(path=out / "flow-desktop-failure.png")


def mobile(page: Page, out: Path) -> None:
    fresh(page, 390, 844)
    page.get_by_test_id("load-demo").first.click()
    settled(page)
    found = overlaps(page)
    check("no overlaps with routes (mobile, sheet at peek)", not found, "; ".join(found))
    page.screenshot(path=out / "flow-mobile-peek.png")
    page.get_by_test_id("sheet-handle").click()
    page.wait_for_timeout(300)
    page.screenshot(path=out / "flow-mobile-half.png")
    page.locator("li.drone").first.get_by_test_id("drone-more").click()
    page.get_by_role("menuitem", name="Route details").click()
    page.wait_for_timeout(300)
    check("details open as a full-height sheet on mobile", page.get_by_test_id("details-headline").is_visible())
    page.screenshot(path=out / "flow-mobile-details.png")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        for flow in (desktop, mobile):
            page = browser.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            try:
                flow(page, args.out)
            except Exception as exc:  # report and keep going with the next flow
                check(f"{flow.__name__} flow ran to the end", False, f"{type(exc).__name__}: {exc}"[:300])
                page.screenshot(path=args.out / f"flow-{flow.__name__}-crash.png")
            check(f"{flow.__name__}: no page errors", not errors, "; ".join(errors)[:300])
            page.close()
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
