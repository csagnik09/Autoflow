"""Selector handling.

A step selector can be either:
  * a plain Playwright selector string  ->  "#login", "text=Sign in", "xpath=//h1", "role=button[name='Go']"
  * a Playwright Python locator chain   ->  get_by_role("button", name="Sign in")
                                            get_by_label("Email").first
                                            locator("ul > li").nth(2)

Chains are parsed with `ast` and only whitelisted methods with literal arguments
are allowed, so nothing from a flow file is ever eval()'d.
"""
import ast

CHAIN_METHODS = {
    "locator", "get_by_role", "get_by_text", "get_by_label", "get_by_placeholder",
    "get_by_alt_text", "get_by_title", "get_by_test_id", "frame_locator",
    "nth", "filter", "and_", "or_",
}
CHAIN_PROPS = {"first", "last", "content_frame"}
CHAIN_PREFIXES = tuple(m + "(" for m in CHAIN_METHODS if m.startswith(("get_by_", "locator", "frame_locator")))


class SelectorError(ValueError):
    pass


def is_chain(selector: str) -> bool:
    s = (selector or "").strip()
    if s.startswith("page."):
        s = s[5:]
    return s.startswith(CHAIN_PREFIXES)


def parse_chain(expr: str):
    """Turn 'get_by_role("button", name="Go").first' into
    [("get_by_role", ["button"], {"name": "Go"}), ("first", None, None)]."""
    expr = expr.strip()
    if expr.startswith("page."):
        expr = expr[5:]
    try:
        node = ast.parse("_." + expr, mode="eval").body
    except SyntaxError as e:
        raise SelectorError(f"Cannot parse locator: {expr} ({e.msg})")
    ops = []
    while True:
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            name = node.func.attr
            if name not in CHAIN_METHODS:
                raise SelectorError(f"Method not allowed in locator: {name}")
            args = [_literal(a) for a in node.args]
            kwargs = {k.arg: _literal(k.value) for k in node.keywords}
            ops.append((name, args, kwargs))
            node = node.func.value
        elif isinstance(node, ast.Attribute):
            if node.attr not in CHAIN_PROPS:
                raise SelectorError(f"Property not allowed in locator: {node.attr}")
            ops.append((node.attr, None, None))
            node = node.value
        elif isinstance(node, ast.Name) and node.id == "_":
            break
        else:
            raise SelectorError(f"Unsupported locator expression: {expr}")
    return list(reversed(ops))


def _literal(node):
    # nested locators inside filter(has=...) are not supported; everything else must be a literal
    try:
        return ast.literal_eval(node)
    except Exception:
        # allow re.compile("...") as a regex argument
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "compile" and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "re"):
            import re
            return re.compile(*[ast.literal_eval(a) for a in node.args])
        raise SelectorError("Locator arguments must be plain values (strings, numbers, booleans)")


def resolve(page, selector: str):
    """Return a Playwright Locator for a selector string or locator chain."""
    selector = (selector or "").strip()
    if not selector:
        raise SelectorError("Selector is empty")
    if not is_chain(selector):
        return page.locator(selector)
    target = page
    for name, args, kwargs in parse_chain(selector):
        attr = getattr(target, name)
        target = attr if args is None else attr(*args, **kwargs)
    return target


def to_python(selector: str) -> str:
    """Python source for this selector (used by the pytest exporter)."""
    selector = (selector or "").strip()
    if is_chain(selector):
        return "page." + (selector[5:] if selector.startswith("page.") else selector)
    return f"page.locator({selector!r})"
