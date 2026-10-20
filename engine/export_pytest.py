"""Convert a flow JSON into a standalone, readable pytest + Playwright test file.

    python engine/export_pytest.py flows/my-flow.json > test_my_flow.py
    pip install pytest-playwright && pytest test_my_flow.py --headed

The exported file uses the `page` fixture from the pytest-playwright plugin, so it
can live in any normal Playwright test suite with no dependency on AutoFlow.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from locators import to_python  # noqa: E402

LABELS = {a["id"]: a["label"] for a in json.loads((Path(__file__).parent / "actions.json").read_text("utf-8"))}

VAR_RE = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")


def slug(name):
    return re.sub(r"[^a-z0-9]+", "_", (name or "flow").lower()).strip("_") or "flow"


def s(value):
    """Python expression for a (possibly templated) string."""
    value = "" if value is None else str(value)
    if VAR_RE.search(value):
        return f"t({value!r})"
    return repr(value)


def L(step):
    return to_python(step.get("selector", ""))


def step_lines(step):
    a = step.get("action")
    sel = L(step) if step.get("selector") else None
    to = f", timeout={int(step['timeout'])}" if step.get("timeout") else ""
    v = step.get("value")
    m = {
        "goto": lambda: [f"page.goto({s(step.get('url'))}{to})"],
        "back": lambda: ["page.go_back()"],
        "reload": lambda: ["page.reload()"],
        "click": lambda: [f"{sel}.click({to[2:]})"],
        "dblclick": lambda: [f"{sel}.dblclick({to[2:]})"],
        "fill": lambda: [f"{sel}.fill({s(v)}{to})"],
        "type": lambda: [f"{sel}.press_sequentially({s(v)}, delay={int(step.get('delay') or 50)})"],
        "press": lambda: [f"{sel}.press({s(step.get('key'))})" if sel else f"page.keyboard.press({s(step.get('key'))})"],
        "check": lambda: [f"{sel}.check()"],
        "uncheck": lambda: [f"{sel}.uncheck()"],
        "select": lambda: [f"{sel}.select_option({s(v)})"],
        "hover": lambda: [f"{sel}.hover()"],
        "upload": lambda: [f"{sel}.set_input_files({s(v)})"],
        "scroll": lambda: [f"{sel}.scroll_into_view_if_needed()" if sel
                           else 'page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")'],
        "wait_for": lambda: [f"{sel}.first.wait_for(state={(step.get('state') or 'visible')!r}{to})"],
        "wait_for_url": lambda: [f"page.wait_for_url({s(v) if '*' in str(v) else f're.compile(re.escape({s(v)}))'}{to})"],
        "wait": lambda: [f"page.wait_for_timeout({int(step.get('ms') or 1000)})"],
        "assert_text": lambda: [f"expect({sel}.first).to_contain_text({s(v)}{to})"],
        "assert_visible": lambda: [f"expect({sel}.first).to_be_visible({to[2:]})"],
        "assert_hidden": lambda: [f"expect({sel}).to_be_hidden({to[2:]})"],
        "assert_count": lambda: [f"expect({sel}).to_have_count({int(v or 0)}{to})"],
        "assert_value": lambda: [f"expect({sel}).to_have_value({s(v)}{to})"],
        "assert_url": lambda: [f"expect(page).to_have_url(re.compile(re.escape({s(v)})){to})"],
        "assert_title": lambda: [f"expect(page).to_have_title(re.compile(re.escape({s(v)})){to})"],
        "extract_text": lambda: [
            f"V[{step.get('var')!r}] = [x.strip() for x in {sel}.all_inner_texts()]" if step.get("all")
            else f"V[{step.get('var')!r}] = {sel}.first.inner_text().strip()",
            f"print({step.get('var')!r}, '=', V[{step.get('var')!r}])"],
        "extract_attr": lambda: [f"V[{step.get('var')!r}] = {sel}.first.get_attribute({step.get('attr')!r})"],
        "set_var": lambda: [f"V[{step.get('var')!r}] = {s(v)}"],
        "evaluate": lambda: [(f"V[{step['var']!r}] = " if step.get("var") else "") + f"page.evaluate({step.get('script', '')!r})"],
        "screenshot": lambda: [
            f"{sel}.first.screenshot(path={('screenshots/' + (step.get('name') or 'shot') + '.png')!r})" if sel
            else f"page.screenshot(path={('screenshots/' + (step.get('name') or 'shot') + '.png')!r}, full_page={bool(step.get('full_page'))})"],
        "pdf": lambda: [f"page.pdf(path={((step.get('name') or 'page') + '.pdf')!r})"],
        "log": lambda: [f"print({s(v)})"],
    }
    if a not in m:
        return [f"# TODO: unsupported action {a!r}"]
    lines = m[a]()
    if step.get("continue_on_error"):
        body = "\n    ".join(lines)
        return [f"try:\n        {body}\n    except Exception as e:  # continue_on_error\n        print('step failed, continuing:', e)"]
    return lines


def export(flow):
    variables = dict(flow.get("variables") or {})
    out = [
        f'"""{flow.get("name", "Flow")} — exported from AutoFlow.',
        "",
        f"{flow.get('description', '').strip()}".rstrip(),
        "",
        "Run:  pip install pytest-playwright && playwright install chromium",
        f"      pytest {('test_' + slug(flow.get('name')) + '.py')} --headed",
        '"""',
        "import os",
        "import random",
        "import re",
        "import time",
        "",
        "from playwright.sync_api import Page, expect",
        "",
        f"V = {json.dumps(variables, indent=4)}",
        "",
        "",
        "def t(text):",
        '    """Fill in {{variable}} placeholders."""',
        "    def sub(m):",
        "        key = m.group(1)",
        "        if key == 'now':",
        "            return time.strftime('%Y-%m-%d %H:%M:%S')",
        "        if key == 'timestamp':",
        "            return str(int(time.time()))",
        "        if key == 'random':",
        "            return str(random.randint(100000, 999999))",
        "        if key.startswith('env.'):",
        "            return os.environ.get(key[4:], '')",
        "        return str(V.get(key, m.group(0)))",
        r"    for _ in range(5):  # variables may contain {{placeholders}} themselves",
        r"        new = re.sub(r'\{\{\s*([\w.]+)\s*\}\}', sub, text)",
        r"        if new == text:",
        r"            break",
        r"        text = new",
        r"    return text",
        "",
        "",
        f"def test_{slug(flow.get('name'))}(page: Page):",
    ]
    steps = [st for st in flow.get("steps", []) if st.get("enabled") is not False]
    if not steps:
        out.append("    pass")
    for i, st in enumerate(steps, 1):
        label = st.get("description") or LABELS.get(st.get("action"), st.get("action"))
        out.append(f"    # {i}. {label}")
        out.extend("    " + ln for ln in step_lines(st))
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "-"
    data = sys.stdin.read() if src == "-" else Path(src).read_text("utf-8")
    sys.stdout.write(export(json.loads(data)))
