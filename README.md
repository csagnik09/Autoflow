# AutoFlow — visual browser automation with Playwright + pytest

Build browser automations step by step in a web UI, run them with **Playwright** driven by **pytest**, and watch every step pass or fail live — with screenshots, extracted data, traces and a JUnit report. Any flow can be exported as a plain, standalone pytest file.

```
┌─────────────── Browser UI (HTML / CSS / JS) ───────────────┐
│  flows list · step editor · live run panel · recorder      │
└──────────────┬───────────────────────────▲─────────────────┘
               │ REST                      │ Server-Sent Events
┌──────────────▼───────────────────────────┴─────────────────┐
│  server.js  (Node, zero dependencies)                      │
│  stores flows/*.json · spawns pytest · streams "@@AF" JSON  │
└──────────────┬─────────────────────────────────────────────┘
               │ python -m pytest engine/test_flow.py --flow …
┌──────────────▼─────────────────────────────────────────────┐
│  engine/  (pytest + Playwright)                            │
│  one pytest test per step · shared browser page            │
│  screenshots · traces · video · result.json · junit.xml    │
└────────────────────────────────────────────────────────────┘
```

## Setup

Requires **Node 18+** and **Python 3.9+**.

```bash
cd autoflow
pip install -r requirements.txt          # playwright + pytest
python -m playwright install chromium    # add firefox / webkit if you want them
npm start                                # or: node server.js
```

Open **http://localhost:3000**.

Environment variables: `PORT` (default 3000), `HOST` (default 127.0.0.1), `PYTHON` (path to the Python that has playwright + pytest, e.g. a venv's `python`).

## Using it

1. Pick a flow on the left, or **+ New**.
2. Add steps from the **Add step** palette — navigate, click, fill, select, wait, assert, extract data, run JS, screenshot, PDF.
3. Press **▶ Run** (Ctrl+Enter). The ⚙ menu picks the browser, shows the window, adds slow motion, records a trace or video.
4. Watch steps turn green/red. A failing step shows the error and a screenshot of the page at that moment; later steps are skipped unless a step has **“Keep going if this step fails”** (⋯ menu).
5. Saved values appear under **Extracted data**; screenshots/PDFs/traces under **Files**. Every run is kept in **Run history** and on disk in `runs/<run-id>/`.

### Selectors

Any field marked *Selector* accepts either:

| Kind | Examples |
|---|---|
| Playwright selector string | `#login`, `.card >> nth=2`, `text=Sign in`, `xpath=//h1`, `[data-testid=total]` |
| Python locator chain | `get_by_role("button", name="Sign in")`, `get_by_label("Email").first`, `locator(".product").filter(has_text="Fern").get_by_role("button")` |

Chains are parsed with Python's `ast` and only Playwright locator methods with literal arguments are allowed — flow files are never `eval`'d.

### Variables

Write `{{name}}` in any field. Define defaults in **Variables & settings**; data steps create more while running. Built-ins: `{{now}}`, `{{timestamp}}`, `{{random}}`, `{{env.NAME}}` (environment variable — handy for passwords).

### Record instead of typing

**● Record** opens a real browser plus the Playwright Inspector (`playwright codegen`). Click through the site, close the browser, and the recorded actions are appended as steps. You can also paste codegen output into **Python → Import from code**.

### Export to pytest

**⤓ Export .py** downloads a readable, standalone test that only needs `pytest-playwright`:

```bash
pip install pytest-playwright
pytest test_my_flow.py --headed
```

## Run from the command line / CI (no UI)

```bash
pytest engine/test_flow.py --flow flows/hacker-news-headlines.json -s
pytest engine/test_flow.py --flow flows/quotes-scraper.json --show-browser --slowmo 300 \
       --af-browser firefox --af-trace --var pages_user=me --junitxml report.xml
```

Options: `--flow`, `--run-dir`, `--af-browser chromium|firefox|webkit|chrome|msedge`, `--show-browser`, `--slowmo MS`, `--af-timeout MS`, `--af-trace`, `--af-video`, `--var name=value` (repeatable).

Open a recorded trace with `python -m playwright show-trace runs/<id>/trace.zip`.

## Included flows

| Flow | What it does |
|---|---|
| Quotes to Scrape | Logs in to quotes.toscrape.com and scrapes two pages of quotes, authors and tags |
| Hacker News headlines | Collects front-page titles + links, full-page screenshot and PDF |

## Adding your own step type

1. Describe it in `engine/actions.json` (id, label, group, fields) — the UI builds its form from this file.
2. Implement it in `engine/actions.py` with `@action("your_id")`.
3. Optionally teach `engine/export_pytest.py` how to write it as Python.

## Project layout

```
server.js               Node HTTP server + REST API + SSE (no npm packages)
public/                 UI: index.html, style.css, app.js
engine/conftest.py      pytest options, fixtures (browser/page), event stream, result.json
engine/test_flow.py     the one test, parametrized into one case per step
engine/actions.py       step implementations (Playwright sync API + expect)
engine/actions.json     step schema shared by UI and engine
engine/locators.py      safe selector / locator-chain resolver
engine/export_pytest.py flow → standalone pytest file
engine/import_codegen.py playwright codegen → steps
flows/                  your flows (JSON)
runs/                   run artifacts: screenshots, traces, junit.xml, pytest.log, result.json
```

### API

`GET/POST /api/flows` · `GET/PUT/DELETE /api/flows/:id` · `POST /api/flows/:id/run` · `GET /api/flows/:id/export` · `GET /api/runs?flow=` · `GET /api/runs/:id/events` (SSE) · `POST /api/runs/:id/stop` · `POST /api/codegen` · `POST /api/import` · `POST /api/export` · `GET /api/actions` · `GET /api/health`

> The server binds to 127.0.0.1 by default because it can launch browsers and run JavaScript you put in flows. Don't expose it to a network without adding authentication.
