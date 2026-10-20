/* AutoFlow front end — plain JS, no build step. */
(() => {
  "use strict";

  // ── state ────────────────────────────────────────────────────────────
  const S = {
    actions: [], actionMap: {},
    flows: [], flowId: null, flow: null, dirty: false,
    runId: null, running: false, es: null,
    rs: freshRunState(),
  };
  function freshRunState() { return { total: 0, steps: {}, vars: {}, files: [], status: "idle", end: null }; }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k in n && typeof v !== "string") n[k] = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(kid));
    return n;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem("autoflow:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("autoflow:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $("#toast");
    t.textContent = msg; t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = "toast"), isErr ? 5000 : 2200);
  }

  function markDirty(on = true) {
    S.dirty = on;
    $("#dirtyDot").hidden = !on;
    if (on) schedulePython();
  }

  // ── boot ──────────────────────────────────────────────────────────────
  async function boot() {
    S.actions = await api("/api/actions");
    S.actionMap = Object.fromEntries(S.actions.map((a) => [a.id, a]));
    renderPalette();
    restoreRunOptions();
    wireUI();
    await loadFlows();
    const last = store.get("lastFlow");
    const pick = S.flows.find((f) => f.id === last) || S.flows[0];
    if (pick) await openFlow(pick.id); else await newFlow();
    checkHealth();
  }

  async function checkHealth() {
    const h = $("#health");
    try {
      const r = await api("/api/health");
      h.className = "health" + (r.ok ? "" : " bad");
      h.textContent = r.ok ? `node ${r.node} · python ${r.detail.split(" ")[0]} · pytest ${r.detail.split(" ")[1]}`
        : `Engine not ready: ${r.detail}\n→ pip install -r requirements.txt\n→ playwright install chromium`;
      h.style.whiteSpace = "pre-wrap";
    } catch { h.textContent = ""; }
  }

  // ── flows ─────────────────────────────────────────────────────────────
  async function loadFlows() {
    S.flows = await api("/api/flows");
    renderFlowList();
  }

  function renderFlowList() {
    const ul = $("#flowList"); ul.replaceChildren();
    for (const f of S.flows) {
      ul.append(el("li", { class: f.id === S.flowId ? "active" : "", onclick: () => openFlow(f.id), title: f.description },
        el("span", { class: "fname", text: f.name }),
        el("span", { class: "fmeta", text: `${f.steps} step${f.steps === 1 ? "" : "s"}` })));
    }
  }

  function confirmDiscard() {
    return !S.dirty || confirm("You have unsaved changes. Discard them?");
  }

  async function openFlow(id) {
    if (id !== S.flowId && !confirmDiscard()) return;
    const flow = await api(`/api/flows/${id}`);
    S.flowId = id; S.flow = normalize(flow);
    store.set("lastFlow", id);
    markDirty(false);
    clearRunView();
    renderAll();
    loadRuns();
  }

  function normalize(f) {
    return {
      name: f.name || "Untitled flow", description: f.description || "",
      variables: f.variables || {}, settings: f.settings || {}, steps: (f.steps || []).map((s) => ({ ...s })),
    };
  }

  async function newFlow() {
    if (!confirmDiscard()) return;
    const created = await api("/api/flows", {
      method: "POST",
      body: { name: "New flow", description: "", steps: [{ action: "goto", url: "https://example.com" }, { action: "screenshot", name: "home" }] },
    });
    await loadFlows();
    S.dirty = false;
    await openFlow(created.id);
    $("#flowName").select();
  }

  async function saveFlow(quiet = false) {
    if (!S.flowId) return;
    const body = serialize();
    await api(`/api/flows/${S.flowId}`, { method: "PUT", body });
    markDirty(false);
    await loadFlows();
    if (!quiet) toast("Saved");
  }

  function serialize() {
    const clean = (s) => Object.fromEntries(Object.entries(s).filter(([k, v]) => !k.startsWith("_") && v !== "" && v != null && v !== false || k === "enabled" && v === false));
    return { ...S.flow, steps: S.flow.steps.map(clean) };
  }

  async function deleteFlow() {
    if (!confirm(`Delete “${S.flow.name}”? Run history stays on disk.`)) return;
    await api(`/api/flows/${S.flowId}`, { method: "DELETE" });
    S.flowId = null; S.dirty = false;
    await loadFlows();
    if (S.flows[0]) await openFlow(S.flows[0].id); else await newFlow();
  }

  // ── rendering: editor ─────────────────────────────────────────────────
  function renderAll() {
    $("#flowName").value = S.flow.name;
    $("#flowDesc").value = S.flow.description;
    autoGrow($("#flowDesc"));
    renderSteps(); renderVarsTab(); renderJSON(); refreshPython();
    renderFlowList();
  }

  function renderPalette() {
    const groups = {};
    for (const a of S.actions) (groups[a.group] ||= []).push(a);
    const box = $("#palette"); box.replaceChildren();
    for (const [g, list] of Object.entries(groups)) {
      box.append(el("div", { class: "pgroup" }, el("span", { class: "pgroup-name", text: g }),
        list.map((a) => el("button", { class: "pbtn", title: a.id, onclick: () => addStep(a.id) }, el("i", { text: a.icon }), a.label))));
    }
  }

  function actionSelect(current) {
    const sel = el("select", { class: "step-action", "aria-label": "Action" });
    const groups = {};
    for (const a of S.actions) (groups[a.group] ||= []).push(a);
    for (const [g, list] of Object.entries(groups)) {
      const og = el("optgroup", { label: g });
      for (const a of list) og.append(el("option", { value: a.id, text: a.label, selected: a.id === current }));
      sel.append(og);
    }
    if (!S.actionMap[current]) sel.prepend(el("option", { value: current, text: `? ${current}`, selected: true }));
    return sel;
  }

  function renderSteps() {
    const ol = $("#steps"); ol.replaceChildren();
    S.flow.steps.forEach((step, i) => ol.append(renderStep(step, i)));
    $("#emptySteps").hidden = S.flow.steps.length > 0;
    $("#stepCount").textContent = S.flow.steps.length || "";
  }

  function renderStep(step, i) {
    const def = S.actionMap[step.action] || { label: step.action, icon: "?", fields: [] };
    const li = el("li", { class: "step", "data-index": i });
    if (step.enabled === false) li.classList.add("disabled");

    // gutter (drag handle + number + live status)
    const gutter = el("div", { class: "step-gutter", draggable: "true", title: "Drag to reorder" },
      el("span", { class: "step-num", text: String(i + 1).padStart(2, "0") }),
      el("span", { class: "step-icon", text: def.icon }),
      el("span", { class: "step-status" }));
    gutter.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", String(i)); e.dataTransfer.effectAllowed = "move"; li.classList.add("dragging"); });
    gutter.addEventListener("dragend", () => li.classList.remove("dragging"));

    // top row
    const sel = actionSelect(step.action);
    sel.addEventListener("change", () => {
      const keep = { action: sel.value, description: step.description, timeout: step.timeout, enabled: step.enabled, continue_on_error: step.continue_on_error };
      const newFields = (S.actionMap[sel.value]?.fields || []).map((f) => f.name);
      for (const k of newFields) if (step[k] != null) keep[k] = step[k];   // carry selector/value over when compatible
      S.flow.steps[i] = keep; markDirty(); renderSteps(); renderJSON();
    });
    const desc = el("input", { class: "step-desc", placeholder: def.label, value: step.description || "", "aria-label": "Step description" });
    desc.addEventListener("input", () => { step.description = desc.value; markDirty(); });

    const advOpen = !!(step.timeout || step.continue_on_error);
    const tools = el("div", { class: "step-tools" },
      el("button", { class: "icon-btn" + (step.enabled === false ? "" : " on"), title: step.enabled === false ? "Enable step" : "Disable step", text: step.enabled === false ? "○" : "●",
        onclick: () => { step.enabled = step.enabled === false ? undefined : false; markDirty(); renderSteps(); renderJSON(); } }),
      el("button", { class: "icon-btn", title: "Run options for this step", text: "⋯", onclick: () => adv.hidden = !adv.hidden }),
      el("button", { class: "icon-btn", title: "Move up", text: "↑", disabled: i === 0, onclick: () => move(i, i - 1) }),
      el("button", { class: "icon-btn", title: "Move down", text: "↓", disabled: i === S.flow.steps.length - 1, onclick: () => move(i, i + 2) }),
      el("button", { class: "icon-btn", title: "Duplicate", text: "⧉", onclick: () => { S.flow.steps.splice(i + 1, 0, structuredClone(stripPrivate(step))); markDirty(); renderSteps(); renderJSON(); } }),
      el("button", { class: "icon-btn", title: "Delete", text: "✕", onclick: () => { S.flow.steps.splice(i, 1); markDirty(); renderSteps(); renderJSON(); } }));

    // fields
    const fields = el("div", { class: "fields" }, def.fields.map((f) => renderField(step, f)));

    // advanced
    const timeout = el("input", { type: "number", min: "0", step: "500", placeholder: "default", value: step.timeout || "" });
    timeout.addEventListener("input", () => { step.timeout = timeout.value ? Number(timeout.value) : undefined; markDirty(); });
    const coe = el("input", { type: "checkbox", checked: !!step.continue_on_error });
    coe.addEventListener("change", () => { step.continue_on_error = coe.checked || undefined; markDirty(); });
    const adv = el("div", { class: "step-adv", hidden: !advOpen },
      el("label", {}, "Timeout (ms) ", timeout),
      el("label", {}, coe, " Keep going if this step fails"));

    const body = el("div", { class: "step-body" }, el("div", { class: "step-top" }, sel, desc, tools), fields, adv, el("div", { class: "step-result", hidden: true }));
    li.append(gutter, body);

    // drop target
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      const after = e.offsetY > li.offsetHeight / 2;
      li.classList.toggle("drop-after", after); li.classList.toggle("drop-before", !after);
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      const after = li.classList.contains("drop-after");
      li.classList.remove("drop-before", "drop-after");
      if (!Number.isNaN(from)) move(from, i + (after ? 1 : 0));
    });

    applyStepStatus(li, i);
    return li;
  }

  function renderField(step, f) {
    const wrap = el("label", { class: "field" + (f.type === "textarea" ? " wide" : "") + (f.type === "checkbox" ? " check" : "") });
    let input;
    if (f.type === "select") {
      input = el("select", {}, f.options.map((o) => el("option", { value: o, text: o, selected: step[f.name] === o })));
      if (step[f.name] == null) step[f.name] = undefined;
    } else if (f.type === "textarea") {
      input = el("textarea", { rows: 2, placeholder: f.placeholder || "", spellcheck: "false" }); input.value = step[f.name] ?? "";
    } else if (f.type === "checkbox") {
      input = el("input", { type: "checkbox", checked: !!step[f.name] });
    } else {
      input = el("input", {
        type: f.type === "number" ? "number" : "text",
        class: f.type === "selector" ? "selector" : "",
        placeholder: f.placeholder || (f.type === "selector" ? '#id, text=Login, get_by_role("button", name="Go")' : ""),
        spellcheck: "false",
      });
      input.value = step[f.name] ?? "";
    }
    const validate = () => input.classList.toggle("invalid", !!f.required && f.type !== "checkbox" && String(input.value).trim() === "");
    input.addEventListener(f.type === "checkbox" || f.type === "select" ? "change" : "input", () => {
      step[f.name] = f.type === "checkbox" ? (input.checked || undefined) : f.type === "number" ? (input.value === "" ? undefined : Number(input.value)) : input.value;
      validate(); markDirty();
    });
    validate();
    if (f.type === "checkbox") wrap.append(input, el("span", { text: f.label + (f.required ? " *" : "") }));
    else wrap.append(el("span", { text: f.label + (f.required ? " *" : "") }), input);
    return wrap;
  }

  const stripPrivate = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith("_")));

  function move(from, to) {
    if (to > from) to -= 1;
    if (from === to || to < 0 || to >= S.flow.steps.length) return;
    const [s] = S.flow.steps.splice(from, 1);
    S.flow.steps.splice(to, 0, s);
    markDirty(); clearStepStatuses(); renderSteps(); renderJSON();
  }

  function addStep(action) {
    const step = { action };
    if (action === "goto") step.url = "https://";
    if (action === "wait") step.ms = 1000;
    S.flow.steps.push(step);
    markDirty(); renderSteps(); renderJSON();
    const last = $("#steps").lastElementChild;
    last?.scrollIntoView({ behavior: "smooth", block: "center" });
    last?.querySelector(".fields input, .fields textarea")?.focus();
  }

  // variables & settings tab
  function renderVarsTab() {
    const tbody = $("#varRows"); tbody.replaceChildren();
    const entries = Object.entries(S.flow.variables);
    entries.forEach(([k, v], idx) => tbody.append(varRow(k, v, idx)));
    for (const inp of $$("[data-setting]")) inp.value = S.flow.settings[inp.dataset.setting] ?? "";
  }
  function varRow(k, v) {
    const name = el("input", { value: k, placeholder: "name" });
    const val = el("input", { value: typeof v === "string" ? v : JSON.stringify(v), placeholder: "value" });
    const sync = () => {
      const next = {};
      for (const tr of $$("#varRows tr")) {
        const [n, vv] = $$("input", tr);
        if (n.value.trim()) next[n.value.trim()] = vv.value;
      }
      S.flow.variables = next; markDirty(); renderJSON();
    };
    name.addEventListener("change", sync); val.addEventListener("input", sync);
    return el("tr", {}, el("td", {}, name), el("td", {}, val),
      el("td", {}, el("button", { class: "icon-btn", text: "✕", title: "Remove", onclick: (e) => { e.target.closest("tr").remove(); sync(); } })));
  }

  function renderJSON() {
    $("#jsonEditor").value = JSON.stringify(serialize(), null, 2);
    $("#jsonError").textContent = "";
  }

  let pyTimer;
  function schedulePython() { clearTimeout(pyTimer); pyTimer = setTimeout(refreshPython, 600); }
  async function refreshPython() {
    if (!$("#tab-python").classList.contains("active") || !S.flow) return;
    try {
      const res = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(serialize()) });
      $("#pyPreview").textContent = await res.text();
    } catch (e) { $("#pyPreview").textContent = "# " + e.message; }
  }

  function autoGrow(t) { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; }

  // ── runs ──────────────────────────────────────────────────────────────
  function runOptions() {
    const o = {
      browser: $("#optBrowser").value, headed: $("#optHeaded").checked, slowmo: Number($("#optSlowmo").value),
      timeout: Number($("#optTimeout").value) || 10000, trace: $("#optTrace").checked, video: $("#optVideo").checked,
    };
    store.set("runOptions", o);
    return o;
  }
  function restoreRunOptions() {
    const o = store.get("runOptions", {});
    if (o.browser) $("#optBrowser").value = o.browser;
    $("#optHeaded").checked = !!o.headed;
    $("#optSlowmo").value = o.slowmo || 0; $("#slowmoVal").textContent = `${o.slowmo || 0} ms`;
    if (o.timeout) $("#optTimeout").value = o.timeout;
    $("#optTrace").checked = !!o.trace; $("#optVideo").checked = !!o.video;
  }

  async function runFlow() {
    if (S.running) return;
    if (!S.flow.steps.length) return toast("Add a step first", true);
    try {
      if (S.dirty) await saveFlow(true);
      const { id } = await api(`/api/flows/${S.flowId}/run`, { method: "POST", body: runOptions() });
      watchRun(id, true);
      loadRuns();
    } catch (e) { toast(e.message, true); }
  }

  async function stopRun() {
    if (S.runId) await api(`/api/runs/${S.runId}/stop`, { method: "POST" }).catch(() => {});
  }

  function clearRunView() {
    S.es?.close(); S.es = null; S.runId = null; S.rs = freshRunState();
    setRunning(false);
    $("#runTitle").textContent = "Not run yet";
    setBadge("idle");
    $("#runLog").replaceChildren(); $("#runStats").replaceChildren();
    renderRunVars(); renderRunFiles(); updateProgress();
    clearStepStatuses();
  }

  function watchRun(id, live = false) {
    clearRunView();
    S.runId = id;
    S.rs.total = S.flow.steps.length;
    $("#runTitle").textContent = live ? "Starting…" : `Run ${id.slice(0, 15).replace(/^(\d{8})-(\d{4})(\d{2})/, "$1 $2:$3")}`;
    if (live) { setRunning(true); setBadge("running"); }
    highlightRun(id);
    const es = new EventSource(`/api/runs/${id}/events`);
    S.es = es;
    es.onmessage = (m) => handleEvent(JSON.parse(m.data));
    es.onerror = () => { if (S.es === es && !S.running) es.close(); };
  }

  function handleEvent(e) {
    const rs = S.rs;
    switch (e.event) {
      case "run_start":
        rs.total = e.steps; rs.status = "running"; setRunning(true); setBadge("running");
        $("#runTitle").textContent = `${e.flow} · ${e.browser}`;
        log(`▶ ${e.flow} — ${e.steps} steps on ${e.browser}`, "l-step");
        break;
      case "step_start":
        rs.steps[e.index] = { status: "running" };
        updateStepStatus(e.index);
        log(`  ${pad(e.index + 1)} ${e.label} …`, "l-dim");
        break;
      case "step_end":
        rs.steps[e.index] = e;
        updateStepStatus(e.index); updateProgress();
        if (e.status === "passed") log(`  ${pad(e.index + 1)} ✓ ${e.detail ? e.detail : ""}  (${e.duration}s)`, "l-pass");
        else if (e.status === "failed") log(`  ${pad(e.index + 1)} ✕ ${e.error}`, "l-err");
        else log(`  ${pad(e.index + 1)} – skipped (${e.detail || ""})`, "l-dim");
        if (e.screenshot) addFile({ path: e.screenshot, kind: "failure", index: e.index });
        break;
      case "var":
        rs.vars[e.name] = e.value; renderRunVars();
        break;
      case "file":
        addFile(e);
        break;
      case "console":
        log(`  [browser ${e.type}] ${e.text}`, e.type === "error" || e.type === "pageerror" ? "l-err" : "l-dim");
        break;
      case "log":
        if (/^(=+|\.+|s+|F+|platform |rootdir|collected|configfile)/.test(e.text) && e.stream === "stdout" && !/FAILED|ERROR|Error/.test(e.text)) { log(e.text, "l-dim"); break; }
        log(e.text, e.stream === "stderr" || /Error|FAILED|ERROR/.test(e.text) ? "l-err" : "");
        break;
      case "run_end":
        rs.end = e;
        if (e.vars) { for (const [k, v] of Object.entries(e.vars)) if (!(k in (S.flow.variables || {}))) rs.vars[k] = v; renderRunVars(); }
        if (e.files) for (const f of e.files) addFile({ path: f.path, kind: f.kind, index: f.step - 1 });
        renderStats();
        log(`■ ${e.status.toUpperCase()} — ${e.passed} passed, ${e.failed} failed, ${e.skipped} skipped in ${e.duration}s`, e.status === "passed" ? "l-pass" : "l-err");
        break;
      case "done":
        rs.status = e.status; setRunning(false); setBadge(e.status); updateProgress();
        S.es?.close();
        if (S.running === false) loadRuns();
        if (e.status === "passed") toast("Flow passed ✓");
        else if (e.status === "failed") toast("Flow failed — see the red step", true);
        else if (e.status === "error") toast("The engine could not run — check the console", true);
        break;
    }
  }

  const pad = (n) => String(n).padStart(2, "0");

  function log(text, cls = "") {
    const pre = $("#runLog");
    const nearBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    pre.append(el("span", { class: cls, text: text + "\n" }));
    if (nearBottom) pre.scrollTop = pre.scrollHeight;
  }

  function setRunning(on) {
    S.running = on;
    $("#btnRun").hidden = on; $("#btnStop").hidden = !on;
  }
  function setBadge(status) {
    const b = $("#runBadge"); b.className = "badge " + status; b.textContent = status;
    $(".progress").className = "progress " + status;
  }
  function updateProgress() {
    const done = Object.values(S.rs.steps).filter((s) => s.status !== "running").length;
    $("#progressBar").style.width = S.rs.total ? `${Math.min(100, (done / S.rs.total) * 100)}%` : "0";
  }
  function renderStats() {
    const e = S.rs.end; if (!e) return;
    $("#runStats").replaceChildren(
      el("span", {}, el("b", { class: "p", text: e.passed }), " passed"),
      el("span", {}, el("b", { class: "f", text: e.failed }), " failed"),
      el("span", {}, el("b", { text: e.skipped }), " skipped"),
      el("span", {}, el("b", { text: e.duration + "s" })),
      el("a", { href: `/runs/${S.runId}/junit.xml`, target: "_blank", text: "junit.xml" }),
      el("a", { href: `/runs/${S.runId}/pytest.log`, target: "_blank", text: "pytest.log" }));
  }

  function clearStepStatuses() { for (const li of $$("#steps .step")) applyStepStatus(li, -1); }
  function updateStepStatus(i) {
    const li = $(`#steps .step[data-index="${i}"]`);
    if (li) { applyStepStatus(li, i); if (S.rs.steps[i]?.status === "running" || S.rs.steps[i]?.status === "failed") li.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }
  function applyStepStatus(li, i) {
    li.classList.remove("st-running", "st-passed", "st-failed", "st-skipped");
    const r = S.rs.steps[i];
    const badge = $(".step-status", li), out = $(".step-result", li);
    badge.textContent = ""; out.hidden = true; out.replaceChildren();
    if (!r) return;
    li.classList.add("st-" + r.status);
    badge.textContent = { running: "•", passed: "✓", failed: "✕", skipped: "–" }[r.status] || "";
    if (r.status === "failed") {
      out.className = "step-result err"; out.hidden = false;
      out.append(r.error || "Failed");
      if (r.screenshot) out.append(el("img", { src: `/runs/${S.runId}/${r.screenshot}`, alt: "Page at failure", onclick: () => lightbox(`/runs/${S.runId}/${r.screenshot}`, r.screenshot) }));
    } else if (r.status === "passed" && r.detail) {
      out.className = "step-result ok"; out.hidden = false; out.textContent = r.detail;
    }
  }

  function renderRunVars() {
    const box = $("#runVars"); const entries = Object.entries(S.rs.vars);
    $("#varCount").textContent = entries.length || "";
    if (!entries.length) return box.replaceChildren(el("p", { class: "muted small", text: "Values saved by data steps appear here." }));
    box.replaceChildren(...entries.map(([k, v]) => {
      const val = Array.isArray(v) ? el("ol", {}, v.slice(0, 200).map((x) => el("li", { text: typeof x === "string" ? x : JSON.stringify(x) })))
        : el("div", { text: typeof v === "string" ? v : JSON.stringify(v, null, 2) });
      return el("div", { class: "var-item" },
        el("div", { class: "vname" }, el("span", { text: k + (Array.isArray(v) ? ` [${v.length}]` : "") }),
          el("button", { class: "icon-btn", title: "Copy", text: "⧉", onclick: () => copy(typeof v === "string" ? v : JSON.stringify(v, null, 2)) })),
        el("div", { class: "vval" }, val));
    }));
  }

  function addFile(f) {
    if (S.rs.files.some((x) => x.path === f.path)) return;
    S.rs.files.push(f); renderRunFiles();
  }
  function renderRunFiles() {
    const box = $("#runFiles"); const files = S.rs.files;
    $("#fileCount").textContent = files.length || "";
    if (!files.length) return box.replaceChildren(el("p", { class: "muted small", text: "Screenshots, PDFs, traces and videos appear here." }));
    box.replaceChildren(...files.map((f) => {
      const url = `/runs/${S.runId}/${f.path}`;
      const name = f.path.split("/").pop();
      const isImg = /\.png$/i.test(f.path);
      const tile = el("a", { class: "file-tile " + (f.kind || ""), href: url, target: "_blank", title: name },
        isImg ? el("img", { src: url, alt: name, loading: "lazy" })
          : el("div", { class: "ficon", text: { pdf: "▤", trace: "⌗", video: "▶" }[f.kind] || "◫" }),
        el("div", { class: "fcap", text: name }));
      if (isImg) tile.addEventListener("click", (e) => { e.preventDefault(); lightbox(url, name); });
      return tile;
    }));
  }

  function lightbox(src, cap) {
    const lb = $("#lightbox"); $("img", lb).src = src; $(".lightbox-cap", lb).textContent = cap; lb.hidden = false;
  }

  async function loadRuns() {
    if (!S.flowId) return;
    const list = await api(`/api/runs?flow=${encodeURIComponent(S.flowId)}`).catch(() => []);
    const ul = $("#runList"); ul.replaceChildren();
    if (!list.length) ul.append(el("li", { class: "muted", style: "cursor:default", text: "No runs yet" }));
    for (const r of list) {
      const when = new Date(r.startedAt);
      const label = when.toDateString() === new Date().toDateString()
        ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : when.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const score = r.status === "running" ? "…" : r.passed != null ? `${r.passed}/${(r.passed || 0) + (r.failed || 0) + (r.skipped || 0)}` : r.status;
      ul.append(el("li", { "data-run": r.id, class: r.id === S.runId ? "active" : "", title: r.status, onclick: () => r.id !== S.runId && watchRun(r.id, r.status === "running") },
        el("span", { class: "dot " + r.status }), el("span", { class: "when", text: label }), el("span", { class: "score", text: score })));
    }
  }
  function highlightRun(id) { for (const li of $$("#runList li")) li.classList.toggle("active", li.dataset.run === id); }

  // ── recorder / import / export ────────────────────────────────────────
  async function record(url) {
    toast("Recorder opening… close the browser window when you're done");
    $("#btnRecord").disabled = true; $("#btnRecord").textContent = "● Recording…";
    try {
      const r = await api("/api/codegen", { method: "POST", body: { url } });
      appendImported(r.steps, r.skipped);
    } catch (e) { toast(e.message, true); }
    finally { $("#btnRecord").disabled = false; $("#btnRecord").textContent = "● Record"; }
  }

  function appendImported(steps, skipped = []) {
    if (!steps?.length) return toast("No actions were recorded", true);
    S.flow.steps.push(...steps);
    markDirty(); renderSteps(); renderJSON();
    toast(`Added ${steps.length} step${steps.length === 1 ? "" : "s"}` + (skipped.length ? ` (${skipped.length} line(s) skipped)` : ""));
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy failed", true); }
  }

  // ── wiring ────────────────────────────────────────────────────────────
  function wireUI() {
    $("#flowName").addEventListener("input", (e) => { S.flow.name = e.target.value; markDirty(); });
    $("#flowDesc").addEventListener("input", (e) => { S.flow.description = e.target.value; autoGrow(e.target); markDirty(); });
    $("#btnSave").onclick = () => saveFlow().catch((e) => toast(e.message, true));
    $("#btnNewFlow").onclick = () => newFlow().catch((e) => toast(e.message, true));
    $("#btnRun").onclick = runFlow;
    $("#btnStop").onclick = stopRun;
    $("#btnDeleteFlow").onclick = deleteFlow;
    $("#btnExport").onclick = async () => {
      if (S.dirty) await saveFlow(true);
      location.href = `/api/flows/${S.flowId}/export`;
    };

    // run options popover
    const pop = $("#runOpts");
    $("#btnRunOpts").onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; };
    document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true; });
    $("#optSlowmo").addEventListener("input", (e) => ($("#slowmoVal").textContent = `${e.target.value} ms`));
    pop.addEventListener("change", runOptions);

    // tabs
    for (const t of $$(".tab")) t.onclick = () => {
      $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
      $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
      if (t.dataset.tab === "json") renderJSON();
      if (t.dataset.tab === "python") refreshPython();
    };

    // vars & settings
    $("#btnAddVar").onclick = () => { $("#varRows").append(varRow("", "")); $("#varRows tr:last-child input").focus(); };
    for (const inp of $$("[data-setting]")) inp.addEventListener("input", () => {
      const v = inp.value.trim();
      if (v) S.flow.settings[inp.dataset.setting] = inp.type === "number" ? Number(v) : v; else delete S.flow.settings[inp.dataset.setting];
      markDirty();
    });

    // JSON tab
    $("#btnApplyJson").onclick = () => {
      try {
        const parsed = JSON.parse($("#jsonEditor").value);
        if (!Array.isArray(parsed.steps)) throw new Error("JSON needs a \"steps\" array");
        S.flow = normalize(parsed); markDirty(); renderAll(); toast("Applied");
      } catch (e) { $("#jsonError").textContent = e.message; }
    };

    // import from code
    $("#btnImport").onclick = async () => {
      try {
        const r = await api("/api/import", { method: "POST", body: { code: $("#importCode").value } });
        appendImported(r.steps, r.skipped);
        $("#importMsg").textContent = r.skipped.length ? `Skipped: ${r.skipped.join(" · ")}` : "";
      } catch (e) { toast(e.message, true); }
    };

    // recorder
    const dlg = $("#recordDialog");
    const openRecorder = () => {
      const firstGoto = S.flow.steps.find((s) => s.action === "goto")?.url || "";
      $("#recordUrl").value = firstGoto.includes("{{") ? "" : firstGoto;
      dlg.showModal();
    };
    $("#btnRecord").onclick = openRecorder;
    $("#btnRecord2").onclick = openRecorder;
    dlg.addEventListener("close", () => { if (dlg.returnValue === "ok") record($("#recordUrl").value.trim()); });

    $("#lightbox").onclick = () => ($("#lightbox").hidden = true);

    // keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveFlow(); }
      if (mod && e.key === "Enter") { e.preventDefault(); runFlow(); }
      if (e.key === "Escape") { $("#lightbox").hidden = true; $("#runOpts").hidden = true; }
    });
    window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
  }

  boot().catch((e) => { console.error(e); toast("Could not reach the AutoFlow server: " + e.message, true); });
})();
