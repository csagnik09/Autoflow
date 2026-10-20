"""pytest plumbing for AutoFlow.

Every step of a flow becomes its own pytest test case (test_step[01-goto], ...),
sharing one browser page for the whole session. Progress is streamed to the
Node server as JSON lines on stdout prefixed with "@@AF ".
"""
import json
import os
import random
import re
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

ACTIONS_SCHEMA = {a["id"]: a for a in json.loads((Path(__file__).parent / "actions.json").read_text("utf-8"))}
VAR_RE = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")


# ── CLI options ─────────────────────────────────────────────────────────────
def pytest_addoption(parser):
    g = parser.getgroup("autoflow")
    g.addoption("--flow", required=True, help="Path to a flow .json file")
    g.addoption("--run-dir", default=None, help="Folder for screenshots, traces and result.json")
    g.addoption("--af-browser", default="chromium", help="chromium | firefox | webkit | chrome | msedge")
    g.addoption("--show-browser", action="store_true", help="Run headed (visible browser window)")
    g.addoption("--slowmo", type=int, default=0, help="Slow every action down by N ms")
    g.addoption("--af-timeout", type=int, default=10000, help="Default per-step timeout in ms")
    g.addoption("--af-trace", action="store_true", help="Record a Playwright trace (trace.zip)")
    g.addoption("--af-video", action="store_true", help="Record a video of the run")
    g.addoption("--var", action="append", default=[], help="Override a variable: --var name=value")


def emit(event, **data):
    sys.stdout.write("@@AF " + json.dumps({"event": event, "ts": time.time(), **data}, default=str) + "\n")
    sys.stdout.flush()


def load_flow(config):
    path = Path(config.getoption("--flow"))
    flow = json.loads(path.read_text("utf-8"))
    flow.setdefault("steps", [])
    return flow


# ── Run context: variables, files, step execution ───────────────────────────
class FlowContext:
    def __init__(self, config, flow):
        self.flow = flow
        self.config = config
        run_dir = config.getoption("--run-dir") or f"runs/local-{datetime.now():%Y%m%d-%H%M%S}"
        self.run_dir = Path(run_dir).resolve()
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.default_timeout = config.getoption("--af-timeout")
        self.vars = dict(flow.get("variables") or {})
        for item in config.getoption("--var"):
            k, _, v = item.partition("=")
            self.vars[k.strip()] = v
        self.files = []
        self.results = []
        self.aborted_by = None
        self.step_no = 0
        self.started = time.time()

    # variables
    def set_var(self, name, value):
        self.vars[name] = value
        emit("var", name=name, value=value)

    def render(self, value, depth=0):
        """Fill {{placeholders}}; a variable's own value may contain placeholders too (e.g. {{env.PASSWORD}})."""
        if isinstance(value, str) and depth < 5:
            out = VAR_RE.sub(lambda m: self._lookup(m.group(1), m.group(0)), value)
            return self.render(out, depth + 1) if out != value and VAR_RE.search(out) else out
        return value

    def _lookup(self, key, raw):
        if key == "now":
            return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        if key == "timestamp":
            return str(int(time.time()))
        if key == "random":
            return str(random.randint(100000, 999999))
        if key.startswith("env."):
            return os.environ.get(key[4:], "")
        if key in self.vars:
            v = self.vars[key]
            return v if isinstance(v, str) else json.dumps(v)
        return raw  # leave unknown placeholders untouched so the error is obvious

    def add_file(self, path, kind):
        rel = Path(path).resolve().relative_to(self.run_dir).as_posix()
        self.files.append({"path": rel, "kind": kind, "step": self.step_no})
        emit("file", path=rel, kind=kind, index=self.step_no - 1)

    # execution
    def run_step(self, page, index, raw_step):
        from actions import ACTIONS  # imported lazily so --collect-only works without playwright

        self.step_no = index + 1
        name = raw_step.get("action")
        label = raw_step.get("description") or ACTIONS_SCHEMA.get(name, {}).get("label", name)

        if raw_step.get("enabled") is False:
            self._finish(index, "skipped", 0, detail="disabled")
            pytest.skip("step disabled")
        if self.aborted_by is not None:
            self._finish(index, "skipped", 0, detail=f"step {self.aborted_by + 1} failed")
            pytest.skip(f"previous step {self.aborted_by + 1} failed")

        emit("step_start", index=index, action=name, label=label)
        t0 = time.time()
        try:
            if name not in ACTIONS:
                raise ValueError(f"Unknown action '{name}'")
            step = {k: self.render(v) for k, v in raw_step.items()}
            for f in ACTIONS_SCHEMA[name]["fields"]:
                if f.get("required") and str(step.get(f["name"], "")).strip() == "":
                    raise ValueError(f"'{f['label']}' is required for {ACTIONS_SCHEMA[name]['label']}")
            detail = ACTIONS[name](page, step, self)
        except Exception as exc:
            shot = self._failure_shot(page, index)
            if not raw_step.get("continue_on_error"):
                self.aborted_by = index
            message = str(exc).split("\nCall log:")[0].strip()
            self._finish(index, "failed", time.time() - t0, error=message, screenshot=shot,
                         trace=traceback.format_exc(limit=3))
            raise
        self._finish(index, "passed", time.time() - t0, detail=detail)

    def _failure_shot(self, page, index):
        try:
            path = self.run_dir / "shots" / f"FAILED-step-{index + 1:02d}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(path), timeout=5000)
            rel = path.relative_to(self.run_dir).as_posix()
            self.files.append({"path": rel, "kind": "failure", "step": index + 1})
            return rel
        except Exception:
            return None

    def _finish(self, index, status, duration, **extra):
        result = {"index": index, "status": status, "duration": round(duration, 3), **extra}
        self.results.append(result)
        emit("step_end", **result)


# ── Parametrize: one test per step ──────────────────────────────────────────
def pytest_generate_tests(metafunc):
    if "step" in metafunc.fixturenames:
        steps = load_flow(metafunc.config)["steps"]
        ids = [f"{i + 1:02d}-{s.get('action', '?')}" for i, s in enumerate(steps)]
        metafunc.parametrize("step", list(enumerate(steps)), ids=ids)


def pytest_configure(config):
    config._af_ctx = FlowContext(config, load_flow(config))


def pytest_sessionstart(session):
    ctx = session.config._af_ctx
    emit("run_start", flow=ctx.flow.get("name"), steps=len(ctx.flow["steps"]),
         browser=session.config.getoption("--af-browser"), run_dir=str(ctx.run_dir), pid=os.getpid())


def pytest_sessionfinish(session, exitstatus):
    ctx = session.config._af_ctx
    counts = {s: sum(1 for r in ctx.results if r["status"] == s) for s in ("passed", "failed", "skipped")}
    summary = {
        "flow": ctx.flow.get("name"),
        "status": "failed" if counts["failed"] else "passed",
        "duration": round(time.time() - ctx.started, 2),
        **counts,
        "steps": ctx.results,
        "vars": ctx.vars,
        "files": ctx.files,
        "finished_at": datetime.now().isoformat(timespec="seconds"),
    }
    (ctx.run_dir / "result.json").write_text(json.dumps(summary, indent=2, default=str), "utf-8")
    emit("run_end", **{k: v for k, v in summary.items() if k != "steps"})


# ── Playwright fixtures (session-wide: the flow runs in one browser tab) ────
@pytest.fixture(scope="session")
def af(pytestconfig):
    return pytestconfig._af_ctx


@pytest.fixture(scope="session")
def page(pytestconfig, af):
    from playwright.sync_api import sync_playwright

    browser_name = pytestconfig.getoption("--af-browser")
    channel = None
    if browser_name in ("chrome", "msedge"):
        channel, browser_name = browser_name, "chromium"

    settings = af.flow.get("settings") or {}
    with sync_playwright() as p:
        launcher = getattr(p, browser_name)
        browser = launcher.launch(headless=not pytestconfig.getoption("--show-browser"),
                                  slow_mo=pytestconfig.getoption("--slowmo"), channel=channel)
        ctx_args = {"viewport": {"width": int(settings.get("width") or 1280), "height": int(settings.get("height") or 800)}}
        if settings.get("user_agent"):
            ctx_args["user_agent"] = settings["user_agent"]
        if settings.get("locale"):
            ctx_args["locale"] = settings["locale"]
        if pytestconfig.getoption("--af-video"):
            ctx_args["record_video_dir"] = str(af.run_dir / "video")
        context = browser.new_context(**ctx_args)
        context.set_default_timeout(af.default_timeout)
        if pytestconfig.getoption("--af-trace"):
            context.tracing.start(screenshots=True, snapshots=True, sources=False)
        pg = context.new_page()
        pg.on("console", lambda m: emit("console", type=m.type, text=m.text[:500]))
        pg.on("pageerror", lambda e: emit("console", type="pageerror", text=str(e)[:500]))
        yield pg
        if pytestconfig.getoption("--af-trace"):
            context.tracing.stop(path=str(af.run_dir / "trace.zip"))
            af.add_file(af.run_dir / "trace.zip", "trace")
        video = pg.video
        context.close()
        if video:
            try:
                af.add_file(video.path(), "video")
            except Exception:
                pass
        browser.close()
