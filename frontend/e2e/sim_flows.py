"""Acceptance flows for the simulation view (dev tool; needs backend :8000 and ng serve :4200).

    backend/.venv/bin/python frontend/e2e/sim_flows.py --out /tmp/sim-shots

Desktop (1280x720) and mobile (390x844): start a scenario, play/pause with Space, speed,
LIVE -> REPLAY by scrubbing and back, step, draw a zone and see drones react, change the
wind, fail a flying drone, event jump, the playback bar never overlaps map controls and stays
visible with the bottom sheet, keyboard focus, reduced motion. Screenshots go to --out.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from ui_check import intersect, overlaps  # noqa: E402

URL = "http://localhost:4200/simulate"
results: list[tuple[bool, str]] = []


def check(ok: bool, what: str) -> None:
    results.append((bool(ok), what))
    print(("PASS " if ok else "FAIL ") + what)


def box(page: Page, selector: str) -> dict | None:
    """Bounding box with both Playwright's keys (width/height) and ui_check's (w/h)."""
    b = page.locator(selector).first.bounding_box()
    return b and {**b, "w": b["width"], "h": b["height"]}


def blur(page: Page) -> None:
    page.evaluate("document.activeElement && document.activeElement.blur()")


def start(page: Page, scenario: str, speed: int) -> None:
    page.goto(URL)
    page.get_by_test_id(f"scenario-{scenario}").click()
    page.get_by_test_id("sim-start-btn").click()
    expect(page.get_by_test_id("playback-bar")).to_be_visible()
    page.get_by_label(f"{speed} times real time").check()
    blur(page)


def bar_clear_of_controls(page: Page) -> bool:
    bar = box(page, '[data-testid="playback-bar"]')
    controls = page.evaluate(
        """() => [...document.querySelectorAll('.leaflet-control')].map(el => {
             const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height};
           }).filter(b => b.w > 0 && b.h > 0)"""
    )
    return bool(bar) and not any(intersect(bar, c) for c in controls)


def desktop(browser, out: Path) -> None:
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    expect(page.get_by_test_id("sim-start")).to_be_visible()
    check(page.get_by_test_id("scenario-twenty_drones").count() == 1, "desktop: scenario picker lists the 20-drone scenario")
    page.screenshot(path=str(out / "sim-desktop-start.png"))

    start(page, "ten_drones_hour", 60)
    check(page.get_by_test_id("sim-mode").inner_text().strip() == "LIVE", "desktop: starts LIVE at T+0")
    check(bar_clear_of_controls(page), "desktop: playback bar does not cover map controls")
    check(not overlaps(page), "desktop: no map overlays overlap")
    page.keyboard.press("Space")
    page.wait_for_timeout(5000)
    page.keyboard.press("Space")
    t_live = page.get_by_test_id("sim-clock").inner_text()
    check("T+" in t_live and "T+0:00" not in t_live, f"desktop: Space plays and pauses ({t_live.splitlines()[-1]})")
    check(page.locator(".sim-drone").count() == 10, "desktop: one marker per drone")
    check(page.locator(".sim-drone .sd-arrow[style*='rotate']").count() == 10, "desktop: markers rotated to heading")

    # Draw a zone around a cruising drone; drones react in the feed.
    for _ in range(2):
        page.locator(".leaflet-control-zoom-in").click()
        page.wait_for_timeout(300)
    page.get_by_test_id("zone-draw").click()  # jumps to the newest simulated time and pauses
    page.wait_for_timeout(300)
    cruising = page.locator(".sim-drone[data-state='CRUISE'] .sd-icon").first
    b = cruising.bounding_box()
    cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    for dx, dy in [(-110, -110), (110, -110), (110, 110), (-110, 110)]:
        page.mouse.click(cx + dx, cy + dy)
        page.wait_for_timeout(120)
    page.screenshot(path=str(out / "sim-desktop-drawing.png"))
    page.keyboard.press("Enter")
    expect(page.get_by_test_id("zone-sent")).to_be_visible()
    blur(page)
    page.keyboard.press("Space")
    page.wait_for_timeout(1500)
    page.keyboard.press("Space")
    expect(page.get_by_test_id("zone-reactions")).to_be_visible()
    check(True, f"desktop: drawn zone sent; {page.get_by_test_id('zone-reactions').inner_text()}")
    reacted = [t for t in page.get_by_test_id("feed-item").all_inner_texts() if "Drawn zone 1" in t]
    check(len(reacted) >= 2, f"desktop: the feed shows the zone and drone reactions ({len(reacted)} events)")
    check(page.locator(".leaflet-zonePane-pane path[fill='url(#zp-conditional)']").count() >= 1
          or page.locator("path[fill='url(#zp-conditional)']").count() >= 1, "desktop: the active zone is drawn")

    # Wind and failure.
    page.get_by_test_id("wind-speed").fill("30")
    page.get_by_test_id("wind-dir").fill("90")
    page.get_by_test_id("wind-send").click()
    check("30 km/h" in page.get_by_test_id("wind-msg").inner_text(), "desktop: wind change accepted")
    rows = page.locator("[data-testid^='tl-d']")
    flying = next((rows.nth(i) for i in range(rows.count()) if re.search(r"Cruising|Returning", rows.nth(i).inner_text())), None)
    flying.click()
    expect(page.get_by_test_id("drone-details")).to_be_visible()
    page.get_by_test_id("fail-drone").click()
    blur(page)
    page.keyboard.press("Space")
    page.wait_for_timeout(1000)
    page.keyboard.press("Space")
    expect(flying).to_contain_text("Failed")
    name = flying.locator(".tl-name").inner_text()
    marker = page.locator(".sim-drone[data-state='FAILED']", has=page.locator(".sd-name", has_text=re.compile(f"^{name}$")))
    expect(marker).to_have_count(1)
    check(True, f"desktop: failing {name} shows it as FAILED in the list and on the map")
    check(marker.locator(".sd-glyph svg").count() == 1, "desktop: FAILED has its own glyph")
    expect(page.get_by_test_id("dd-energy")).to_be_visible()
    check(True, "desktop: drawer shows planned vs actual energy")
    page.screenshot(path=str(out / "sim-desktop-live.png"))

    # Replay: scrub back, then Go live.
    page.get_by_test_id("sim-scrubber").focus()
    page.keyboard.press("Home")
    expect(page.get_by_test_id("sim-mode")).to_contain_text("REPLAY")
    check(True, "desktop: scrubbing back switches to REPLAY")
    check(page.get_by_test_id("inject-replay").is_visible(), "desktop: changes are disabled while replaying")
    page.wait_for_timeout(800)
    page.screenshot(path=str(out / "sim-desktop-replay.png"))
    page.keyboard.press("l")
    expect(page.get_by_test_id("sim-mode")).to_contain_text("LIVE")
    check(True, "desktop: L goes back to LIVE")

    # Event jump.
    item = page.get_by_test_id("feed-item").nth(4)
    item.click()
    expect(page.get_by_test_id("sim-mode")).to_contain_text("REPLAY")
    check(True, "desktop: clicking an event jumps to its time")

    # Step.
    page.keyboard.press("l")
    before = page.get_by_test_id("sim-clock").inner_text().splitlines()[-1]
    blur(page)
    page.keyboard.press(".")
    page.wait_for_timeout(600)
    after = page.get_by_test_id("sim-clock").inner_text().splitlines()[-1]
    check(before != after, f"desktop: '.' steps one tick ({before} -> {after})")

    # Keyboard: the play button and a drone marker are reachable and show focus.
    page.get_by_test_id("sim-play").focus()
    outline = page.evaluate("getComputedStyle(document.activeElement).outlineStyle")
    check(outline != "none", "desktop: focused controls show a focus ring")
    check(page.locator(".sim-drone-icon[tabindex='0']").count() == 10, "desktop: drone markers are keyboard focusable")
    check(not errors, f"desktop: no page errors {errors[:2]}")
    page.close()


def mobile(browser, out: Path) -> None:
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, reduced_motion="reduce")
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    expect(page.get_by_test_id("sim-start")).to_be_visible()
    page.screenshot(path=str(out / "sim-mobile-start.png"))
    start(page, "twenty_drones", 20)
    page.wait_for_timeout(300)
    check(page.get_by_test_id("sheet-handle").get_attribute("aria-expanded") == "false", "mobile: sheet lowered once running")
    check(bar_clear_of_controls(page), "mobile: playback bar does not cover map controls")
    check(not overlaps(page), "mobile: no map overlays overlap")
    page.get_by_test_id("sim-play").click()
    page.wait_for_timeout(4000)
    page.get_by_test_id("sim-play").click()
    for state in ("peek", "half", "full"):
        bar = box(page, '[data-testid="playback-bar"]')
        sheet = box(page, "aside.sidebar")
        check(bar and sheet and bar["y"] + bar["height"] <= sheet["y"] + 1, f"mobile: bar above the sheet ({state})")
        page.screenshot(path=str(out / f"sim-mobile-{state}.png"))
        page.get_by_test_id("sheet-handle").click()
        page.wait_for_timeout(400)
    width = page.evaluate("document.documentElement.scrollWidth")
    check(width <= 390, f"mobile: no horizontal scroll ({width}px)")
    play = box(page, '[data-testid="sim-play"]')
    check(play and play["width"] >= 32 and play["height"] >= 32, "mobile: play button is at least 32 px")
    anim = page.evaluate("""() => { const el = document.querySelector('.pb-dot');
        return el ? getComputedStyle(el).animationName : 'none'; }""")
    check(anim == "none", "mobile: reduced motion turns the LIVE pulse off")
    check(not errors, f"mobile: no page errors {errors[:2]}")
    ctx.close()


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        desktop(browser, args.out)
        mobile(browser, args.out)
        browser.close()
    passed = sum(ok for ok, _ in results)
    print(f"{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
