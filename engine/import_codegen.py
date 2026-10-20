"""Turn Python code recorded by `playwright codegen` into AutoFlow steps.

    python engine/import_codegen.py recorded.py   ->  prints {"steps": [...], "skipped": [...]}

Works with the `python` and `python-pytest` codegen targets. Only statically
parsed (ast) — the recorded code is never executed.
"""
import ast
import re
import json
import sys
from pathlib import Path

PAGE_NAMES = {"page", "page1", "page2", "page3"}

LOCATOR_ACTIONS = {
    "click": "click", "dblclick": "dblclick", "fill": "fill", "press": "press",
    "check": "check", "uncheck": "uncheck", "select_option": "select", "hover": "hover",
    "set_input_files": "upload", "press_sequentially": "type", "type": "type",
}
EXPECT_ACTIONS = {
    "to_be_visible": "assert_visible", "to_be_hidden": "assert_hidden",
    "to_contain_text": "assert_text", "to_have_text": "assert_text",
    "to_have_count": "assert_count", "to_have_value": "assert_value",
    "to_have_url": "assert_url", "to_have_title": "assert_title",
}


def _root_is_page(node):
    while isinstance(node, (ast.Call, ast.Attribute)):
        node = node.func if isinstance(node, ast.Call) else node.value
    return isinstance(node, ast.Name) and node.id in PAGE_NAMES


def _chain_src(node):
    """'page.get_by_role("button", name="Go").first' -> 'get_by_role("button", name="Go").first'"""
    src = ast.unparse(node)
    head, _, rest = src.partition(".")
    return rest if head in PAGE_NAMES else src


def _lit(node, default=""):
    try:
        return ast.literal_eval(node)
    except Exception:
        # re.compile("x") -> "x"
        if isinstance(node, ast.Call) and node.args:
            try:
                return ast.literal_eval(node.args[0])
            except Exception:
                pass
        return default


def convert_call(call):
    """Return a step dict for one recorded call, or None."""
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute):
        return None
    method, target = call.func.attr, call.func.value
    args = call.args

    # expect(locator|page).to_xxx(...)
    if (isinstance(target, ast.Call) and isinstance(target.func, ast.Name)
            and target.func.id == "expect" and method in EXPECT_ACTIONS):
        subject = target.args[0]
        action = EXPECT_ACTIONS[method]
        step = {"action": action}
        if isinstance(subject, ast.Name) and subject.id in PAGE_NAMES:
            value = str(_lit(args[0])) if args else ""
            if args and isinstance(args[0], ast.Call):
                # re.compile(".*login\\.html") -> "login.html" (AutoFlow checks URL/title with "contains")
                value = re.sub(r"^\^?(\.\*)+|(\.\*)+\$?$", "", value).replace("\\", "")
            step["value"] = value
            return step
        step["selector"] = _chain_src(subject)
        if args:
            val = _lit(args[0])
            step["value"] = " ".join(val) if isinstance(val, list) else val
        return step

    if not _root_is_page(target):
        return None

    # page.goto / page.keyboard.press / page.go_back / page.reload
    if isinstance(target, ast.Name):
        if method == "goto" and args:
            return {"action": "goto", "url": _lit(args[0])}
        if method == "go_back":
            return {"action": "back"}
        if method == "reload":
            return {"action": "reload"}
        if method == "wait_for_url" and args:
            return {"action": "wait_for_url", "value": str(_lit(args[0]))}
        if method == "wait_for_timeout" and args:
            return {"action": "wait", "ms": _lit(args[0], 1000)}
        if method == "screenshot":
            return {"action": "screenshot", "name": "recorded"}
        return None
    if isinstance(target, ast.Attribute) and target.attr == "keyboard" and method == "press" and args:
        return {"action": "press", "key": _lit(args[0])}

    if method in LOCATOR_ACTIONS:
        step = {"action": LOCATOR_ACTIONS[method], "selector": _chain_src(target)}
        if method == "press" and args:
            step["key"] = _lit(args[0])
        elif method in ("fill", "select_option", "set_input_files", "press_sequentially", "type") and args:
            step["value"] = _lit(args[0])
        return step
    return None


def convert(source):
    tree = ast.parse(source)
    steps, skipped = [], []
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr):
            step = convert_call(node.value)
            if step:
                steps.append((node.lineno, step))
            elif isinstance(node.value, ast.Call) and _root_is_page(getattr(node.value.func, "value", None) or node.value):
                skipped.append(ast.unparse(node.value))
    steps.sort(key=lambda x: x[0])
    return {"steps": [s for _, s in steps], "skipped": skipped}


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "-"
    code = sys.stdin.read() if src == "-" else Path(src).read_text("utf-8")
    print(json.dumps(convert(code), indent=2))
