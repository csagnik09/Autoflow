"""Implementation of every step type listed in actions.json.

Each handler receives (page, step, ctx) where `step` already has {{variables}}
substituted, and returns an optional short detail string for the run log.
"""
import re
import time
from pathlib import Path

from playwright.sync_api import expect

from locators import resolve

ACTIONS = {}


def action(name):
    def deco(fn):
        ACTIONS[name] = fn
        return fn
    return deco


def _timeout(step, ctx):
    return int(step.get("timeout") or ctx.default_timeout)


def _safe_name(name, default):
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(name or "").strip()) or default
    return name


# ── Navigate ────────────────────────────────────────────────────────────────
@action("goto")
def goto(page, step, ctx):
    resp = page.goto(step["url"], timeout=_timeout(step, ctx))
    return f"{resp.status if resp else '-'} {page.url}"


@action("back")
def back(page, step, ctx):
    page.go_back(timeout=_timeout(step, ctx))
    return page.url


@action("reload")
def reload(page, step, ctx):
    page.reload(timeout=_timeout(step, ctx))
    return page.url


# ── Interact ────────────────────────────────────────────────────────────────
@action("click")
def click(page, step, ctx):
    resolve(page, step["selector"]).click(timeout=_timeout(step, ctx))


@action("dblclick")
def dblclick(page, step, ctx):
    resolve(page, step["selector"]).dblclick(timeout=_timeout(step, ctx))


@action("fill")
def fill(page, step, ctx):
    resolve(page, step["selector"]).fill(str(step.get("value", "")), timeout=_timeout(step, ctx))


@action("type")
def type_(page, step, ctx):
    resolve(page, step["selector"]).press_sequentially(
        str(step.get("value", "")), delay=int(step.get("delay") or 50), timeout=_timeout(step, ctx))


@action("press")
def press(page, step, ctx):
    if step.get("selector"):
        resolve(page, step["selector"]).press(step["key"], timeout=_timeout(step, ctx))
    else:
        page.keyboard.press(step["key"])


@action("check")
def check(page, step, ctx):
    resolve(page, step["selector"]).check(timeout=_timeout(step, ctx))


@action("uncheck")
def uncheck(page, step, ctx):
    resolve(page, step["selector"]).uncheck(timeout=_timeout(step, ctx))


@action("select")
def select(page, step, ctx):
    # a plain string matches an <option> by value or by visible label
    picked = resolve(page, step["selector"]).select_option(str(step["value"]), timeout=_timeout(step, ctx))
    return ", ".join(picked)


@action("hover")
def hover(page, step, ctx):
    resolve(page, step["selector"]).hover(timeout=_timeout(step, ctx))


@action("upload")
def upload(page, step, ctx):
    path = Path(step["value"]).expanduser()
    resolve(page, step["selector"]).set_input_files(str(path), timeout=_timeout(step, ctx))
    return path.name


@action("scroll")
def scroll(page, step, ctx):
    if step.get("selector"):
        resolve(page, step["selector"]).scroll_into_view_if_needed(timeout=_timeout(step, ctx))
    else:
        page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")


# ── Wait ────────────────────────────────────────────────────────────────────
@action("wait_for")
def wait_for(page, step, ctx):
    resolve(page, step["selector"]).first.wait_for(
        state=step.get("state") or "visible", timeout=_timeout(step, ctx))


@action("wait_for_url")
def wait_for_url(page, step, ctx):
    value = step["value"]
    pattern = value if any(c in value for c in "*?") else re.compile(re.escape(value))
    page.wait_for_url(pattern, timeout=_timeout(step, ctx))
    return page.url


@action("wait")
def wait(page, step, ctx):
    page.wait_for_timeout(int(step.get("ms") or 1000))


# ── Assert (Playwright's auto-retrying expect) ──────────────────────────────
@action("assert_text")
def assert_text(page, step, ctx):
    expect(resolve(page, step["selector"]).first).to_contain_text(str(step["value"]), timeout=_timeout(step, ctx))


@action("assert_visible")
def assert_visible(page, step, ctx):
    expect(resolve(page, step["selector"]).first).to_be_visible(timeout=_timeout(step, ctx))


@action("assert_hidden")
def assert_hidden(page, step, ctx):
    expect(resolve(page, step["selector"])).to_be_hidden(timeout=_timeout(step, ctx))


@action("assert_count")
def assert_count(page, step, ctx):
    expect(resolve(page, step["selector"])).to_have_count(int(step["value"]), timeout=_timeout(step, ctx))


@action("assert_value")
def assert_value(page, step, ctx):
    expect(resolve(page, step["selector"])).to_have_value(str(step["value"]), timeout=_timeout(step, ctx))


@action("assert_url")
def assert_url(page, step, ctx):
    expect(page).to_have_url(re.compile(re.escape(step["value"])), timeout=_timeout(step, ctx))
    return page.url


@action("assert_title")
def assert_title(page, step, ctx):
    expect(page).to_have_title(re.compile(re.escape(step["value"])), timeout=_timeout(step, ctx))
    return page.title()


# ── Data ────────────────────────────────────────────────────────────────────
@action("extract_text")
def extract_text(page, step, ctx):
    loc = resolve(page, step["selector"])
    if step.get("all"):
        loc.first.wait_for(timeout=_timeout(step, ctx))
        value = [t.strip() for t in loc.all_inner_texts()]
    else:
        value = loc.first.inner_text(timeout=_timeout(step, ctx)).strip()
    ctx.set_var(step["var"], value)
    return f"{step['var']} = {value!r}"[:300]


@action("extract_attr")
def extract_attr(page, step, ctx):
    value = resolve(page, step["selector"]).first.get_attribute(step["attr"], timeout=_timeout(step, ctx))
    ctx.set_var(step["var"], value)
    return f"{step['var']} = {value!r}"[:300]


@action("set_var")
def set_var(page, step, ctx):
    ctx.set_var(step["var"], step.get("value", ""))
    return f"{step['var']} = {step.get('value', '')!r}"


@action("evaluate")
def evaluate(page, step, ctx):
    result = page.evaluate(step["script"])
    if step.get("var"):
        ctx.set_var(step["var"], result)
    return repr(result)[:300]


# ── Capture ─────────────────────────────────────────────────────────────────
@action("screenshot")
def screenshot(page, step, ctx):
    name = _safe_name(step.get("name"), f"step-{ctx.step_no:02d}")
    path = ctx.run_dir / "shots" / f"{name}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    if step.get("selector"):
        resolve(page, step["selector"]).first.screenshot(path=str(path), timeout=_timeout(step, ctx))
    else:
        page.screenshot(path=str(path), full_page=bool(step.get("full_page")))
    ctx.add_file(path, "screenshot")
    return path.name


@action("pdf")
def pdf(page, step, ctx):
    # PDF printing only works in Chromium headless mode
    name = _safe_name(step.get("name"), f"page-{int(time.time())}")
    path = ctx.run_dir / "files" / f"{name}.pdf"
    path.parent.mkdir(parents=True, exist_ok=True)
    page.pdf(path=str(path))
    ctx.add_file(path, "pdf")
    return path.name


@action("log")
def log(page, step, ctx):
    return str(step.get("value", ""))
