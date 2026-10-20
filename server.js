#!/usr/bin/env node
/**
 * AutoFlow server — zero npm dependencies (Node 18+).
 *
 *  - serves the UI (public/)
 *  - stores flows as JSON files in flows/
 *  - runs a flow by spawning `pytest engine/test_flow.py --flow ...`
 *    and streams its "@@AF " JSON events to the browser over Server-Sent Events
 *  - exports flows to standalone pytest files, imports `playwright codegen` recordings
 */
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const DIRS = {
  public: path.join(ROOT, "public"),
  flows: path.join(ROOT, "flows"),
  runs: path.join(ROOT, "runs"),
  engine: path.join(ROOT, "engine"),
};
for (const d of [DIRS.flows, DIRS.runs]) fs.mkdirSync(d, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".webm": "video/webm", ".pdf": "application/pdf", ".zip": "application/zip", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8", ".py": "text/x-python; charset=utf-8", ".ico": "image/x-icon",
};

/** In-memory registry of runs started by this server (history also lives on disk). */
const runs = new Map(); // id -> { id, flowId, flowName, status, startedAt, events: [], clients: Set, proc }
let codegenProc = null;

// ── helpers ────────────────────────────────────────────────────────────────
const send = (res, code, body, type = "application/json; charset=utf-8") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const fail = (res, code, msg) => send(res, code, { error: msg });
const slug = (s) => String(s || "flow").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "flow";
const safeId = (id) => /^[a-z0-9][a-z0-9-]*$/i.test(id || "");

async function readBody(req, limit = 5e6) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("Body too large"); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveFile(res, base, rel) {
  const file = path.resolve(base, "." + path.posix.normalize("/" + decodeURIComponent(rel)));
  if (!file.startsWith(base)) return fail(res, 403, "Forbidden");
  try {
    let st = await fsp.stat(file);
    let target = file;
    if (st.isDirectory()) { target = path.join(file, "index.html"); st = await fsp.stat(target); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream", "Content-Length": st.size });
    fs.createReadStream(target).pipe(res);
  } catch { fail(res, 404, "Not found"); }
}

function runPython(args, input) {
  return new Promise((resolve) => {
    const p = spawn(PYTHON, args, { cwd: ROOT });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    p.on("close", (code) => resolve({ code, out, err }));
    if (input !== undefined) p.stdin.end(input);
  });
}

// ── flows ──────────────────────────────────────────────────────────────────
const flowPath = (id) => path.join(DIRS.flows, id + ".json");

async function listFlows() {
  const files = (await fsp.readdir(DIRS.flows)).filter((f) => f.endsWith(".json"));
  const flows = await Promise.all(files.map(async (f) => {
    try {
      const data = JSON.parse(await fsp.readFile(path.join(DIRS.flows, f), "utf8"));
      const st = await fsp.stat(path.join(DIRS.flows, f));
      return { id: f.slice(0, -5), name: data.name || f, description: data.description || "", steps: (data.steps || []).length, updatedAt: st.mtimeMs };
    } catch { return null; }
  }));
  return flows.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function uniqueFlowId(name) {
  let base = slug(name), id = base, n = 2;
  while (fs.existsSync(flowPath(id))) id = `${base}-${n++}`;
  return id;
}

function cleanFlow(body) {
  return {
    name: String(body.name || "Untitled flow").slice(0, 120),
    description: String(body.description || ""),
    variables: body.variables && typeof body.variables === "object" ? body.variables : {},
    settings: body.settings && typeof body.settings === "object" ? body.settings : {},
    steps: Array.isArray(body.steps) ? body.steps : [],
  };
}

// ── runs ───────────────────────────────────────────────────────────────────
function broadcast(run, evt) {
  run.events.push(evt);
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const c of run.clients) c.write(line);
}

async function startRun(flowId, opts = {}) {
  const flow = JSON.parse(await fsp.readFile(flowPath(flowId), "utf8"));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const id = `${stamp}-${slug(flowId).slice(0, 30)}-${crypto.randomBytes(2).toString("hex")}`;
  const runDir = path.join(DIRS.runs, id);
  await fsp.mkdir(runDir, { recursive: true });
  // snapshot the flow as it was when run, so history stays meaningful after edits
  await fsp.writeFile(path.join(runDir, "flow.json"), JSON.stringify(flow, null, 2));

  const args = [
    "-m", "pytest", path.join("engine", "test_flow.py"),
    "--flow", path.join(runDir, "flow.json"), "--run-dir", runDir,
    "--junitxml", path.join(runDir, "junit.xml"),
    "-s", "-q", "-p", "no:cacheprovider", "-p", "no:playwright", "--color=no",
    "--af-browser", String(opts.browser || "chromium"),
    "--slowmo", String(Number(opts.slowmo) || 0),
    "--af-timeout", String(Number(opts.timeout) || 10000),
  ];
  if (opts.headed) args.push("--show-browser");
  if (opts.trace) args.push("--af-trace");
  if (opts.video) args.push("--af-video");
  for (const [k, v] of Object.entries(opts.vars || {})) if (k) args.push("--var", `${k}=${v}`);

  const run = { id, flowId, flowName: flow.name, status: "running", startedAt: Date.now(), events: [], clients: new Set(), proc: null };
  runs.set(id, run);

  const proc = spawn(PYTHON, args, {
    cwd: ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
  });
  run.proc = proc;
  const logStream = fs.createWriteStream(path.join(runDir, "pytest.log"));

  const handleLines = (stream, isErr) => {
    let buf = "";
    stream.on("data", (chunk) => {
      logStream.write(chunk);
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
        const at = isErr ? -1 : line.indexOf("@@AF ");
        if (at >= 0) {
          // pytest's progress dots can share a line with an event: "..@@AF {...}"
          try { broadcast(run, JSON.parse(line.slice(at + 5))); continue; } catch { /* fall through as log */ }
        }
        if (line.trim()) broadcast(run, { event: "log", stream: isErr ? "stderr" : "stdout", text: line });
      }
    });
  };
  handleLines(proc.stdout, false);
  handleLines(proc.stderr, true);

  proc.on("error", (e) => {
    broadcast(run, { event: "log", stream: "stderr", text: `Could not start ${PYTHON}: ${e.message}. Set the PYTHON env var to your Python executable.` });
  });
  proc.on("close", (code) => {
    logStream.end();
    const end = run.events.find((e) => e.event === "run_end");
    run.status = run.stopped ? "stopped" : end ? end.status : code === 0 ? "passed" : "error";
    if (!end && !run.stopped) {
      // pytest failed before the flow started (missing deps, bad flow file, …)
      const hint = run.events.filter((e) => e.event === "log").slice(-6).map((e) => e.text).join("\n");
      broadcast(run, { event: "log", stream: "stderr", text: `pytest exited with code ${code}.` });
      if (/No module named ['"]?(pytest|playwright)/.test(hint))
        broadcast(run, { event: "log", stream: "stderr", text: "Install the engine deps:  pip install -r requirements.txt  &&  playwright install chromium" });
    }
    broadcast(run, { event: "done", status: run.status, code });
    for (const c of run.clients) c.end();
    run.clients.clear();
    run.proc = null;
    fsp.writeFile(path.join(runDir, "meta.json"), JSON.stringify({ id, flowId, flowName: flow.name, status: run.status, startedAt: run.startedAt, endedAt: Date.now(), options: opts })).catch(() => {});
  });
  return run;
}

async function listRuns(flowId) {
  const dirs = (await fsp.readdir(DIRS.runs, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const items = await Promise.all(dirs.map(async (id) => {
    const live = runs.get(id);
    if (live && live.status === "running") return { id, flowId: live.flowId, flowName: live.flowName, status: "running", startedAt: live.startedAt };
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(DIRS.runs, id, "meta.json"), "utf8"));
      let result = {};
      try { result = JSON.parse(await fsp.readFile(path.join(DIRS.runs, id, "result.json"), "utf8")); } catch {}
      return { ...meta, passed: result.passed, failed: result.failed, skipped: result.skipped, duration: result.duration };
    } catch { return null; }
  }));
  return items.filter(Boolean).filter((r) => !flowId || r.flowId === flowId).sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
}

// ── codegen recorder ───────────────────────────────────────────────────────
function startCodegen(url) {
  return new Promise((resolve, reject) => {
    if (codegenProc) return reject(new Error("A recording is already open"));
    const out = path.join(DIRS.runs, `codegen-${Date.now()}.py`);
    const args = ["-m", "playwright", "codegen", "--target", "python-pytest", "-o", out];
    if (url) args.push(url);
    codegenProc = spawn(PYTHON, args, { cwd: ROOT });
    let err = "";
    codegenProc.stderr.on("data", (d) => (err += d));
    codegenProc.on("error", (e) => { codegenProc = null; reject(e); });
    codegenProc.on("close", async () => {
      codegenProc = null;
      try {
        const code = await fsp.readFile(out, "utf8");
        resolve({ code });
      } catch { reject(new Error(err.trim() || "Recorder closed without saving any code")); }
    });
  });
}

// ── router ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const parts = p.split("/").filter(Boolean);
  try {
    if (!p.startsWith("/api/")) {
      if (p.startsWith("/runs/")) return serveFile(res, DIRS.runs, p.slice(6));
      return serveFile(res, DIRS.public, p);
    }

    // /api/actions — step schema shared with the Python engine
    if (p === "/api/actions") return serveFile(res, DIRS.engine, "actions.json");

    if (p === "/api/health") {
      const r = await runPython(["-c", "import pytest, playwright, sys; print(sys.version.split()[0], pytest.__version__)"]);
      return send(res, 200, { node: process.version, python: PYTHON, ok: r.code === 0, detail: (r.code === 0 ? r.out : r.err).trim().split("\n").pop() });
    }

    // flows
    if (parts[1] === "flows") {
      const id = parts[2];
      if (!id && req.method === "GET") return send(res, 200, await listFlows());
      if (!id && req.method === "POST") {
        const flow = cleanFlow(await readBody(req));
        const newId = await uniqueFlowId(flow.name);
        await fsp.writeFile(flowPath(newId), JSON.stringify(flow, null, 2));
        return send(res, 201, { id: newId, ...flow });
      }
      if (!safeId(id)) return fail(res, 400, "Bad flow id");
      const sub = parts[3];
      if (!sub && req.method === "GET") {
        try { return send(res, 200, { id, ...JSON.parse(await fsp.readFile(flowPath(id), "utf8")) }); }
        catch { return fail(res, 404, "Flow not found"); }
      }
      if (!sub && req.method === "PUT") {
        const flow = cleanFlow(await readBody(req));
        await fsp.writeFile(flowPath(id), JSON.stringify(flow, null, 2));
        return send(res, 200, { id, ...flow });
      }
      if (!sub && req.method === "DELETE") {
        await fsp.rm(flowPath(id), { force: true });
        return send(res, 200, { ok: true });
      }
      if (sub === "run" && req.method === "POST") {
        if (!fs.existsSync(flowPath(id))) return fail(res, 404, "Flow not found");
        const run = await startRun(id, await readBody(req));
        return send(res, 202, { id: run.id });
      }
      if (sub === "export" && req.method === "GET") {
        const r = await runPython([path.join("engine", "export_pytest.py"), flowPath(id)]);
        if (r.code !== 0) return fail(res, 500, r.err || "Export failed");
        res.writeHead(200, { "Content-Type": MIME[".py"], "Content-Disposition": `attachment; filename="test_${id.replace(/-/g, "_")}.py"` });
        return res.end(r.out);
      }
    }

    // runs
    if (parts[1] === "runs") {
      const id = parts[2];
      if (!id && req.method === "GET") return send(res, 200, await listRuns(url.searchParams.get("flow")));
      if (!safeId(id)) return fail(res, 400, "Bad run id");
      const run = runs.get(id);
      if (parts[3] === "events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        if (!run) {
          // finished run from a previous server session: replay from disk
          try {
            const result = JSON.parse(await fsp.readFile(path.join(DIRS.runs, id, "result.json"), "utf8"));
            for (const s of result.steps) res.write(`data: ${JSON.stringify({ event: "step_end", ...s })}\n\n`);
            res.write(`data: ${JSON.stringify({ event: "run_end", ...result, steps: undefined })}\n\n`);
            res.write(`data: ${JSON.stringify({ event: "done", status: result.status })}\n\n`);
          } catch { res.write(`data: ${JSON.stringify({ event: "done", status: "unknown" })}\n\n`); }
          return res.end();
        }
        for (const e of run.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (!run.proc) return res.end();
        run.clients.add(res);
        req.on("close", () => run.clients.delete(res));
        return;
      }
      if (parts[3] === "stop" && req.method === "POST") {
        if (run?.proc) { run.stopped = true; run.proc.kill(); }
        return send(res, 200, { ok: true });
      }
      if (!parts[3] && req.method === "GET") {
        try { return send(res, 200, JSON.parse(await fsp.readFile(path.join(DIRS.runs, id, "result.json"), "utf8"))); }
        catch { return fail(res, 404, "No result yet"); }
      }
      if (!parts[3] && req.method === "DELETE") {
        if (run?.proc) return fail(res, 409, "Run is still in progress");
        await fsp.rm(path.join(DIRS.runs, id), { recursive: true, force: true });
        runs.delete(id);
        return send(res, 200, { ok: true });
      }
    }

    // recorder & importer
    if (p === "/api/codegen" && req.method === "POST") {
      const { url: target } = await readBody(req);
      try {
        const { code } = await startCodegen(target);
        const r = await runPython([path.join("engine", "import_codegen.py"), "-"], code);
        return send(res, 200, { code, ...(r.code === 0 ? JSON.parse(r.out) : { steps: [], error: r.err }) });
      } catch (e) { return fail(res, 500, e.message); }
    }
    if (p === "/api/export" && req.method === "POST") {
      // live preview of the exported pytest file for an unsaved flow
      const r = await runPython([path.join("engine", "export_pytest.py"), "-"], JSON.stringify(cleanFlow(await readBody(req))));
      return send(res, r.code === 0 ? 200 : 500, r.code === 0 ? r.out : `# export failed\n# ${r.err}`, MIME[".py"]);
    }
    if (p === "/api/import" && req.method === "POST") {
      const { code } = await readBody(req);
      const r = await runPython([path.join("engine", "import_codegen.py"), "-"], String(code || ""));
      if (r.code !== 0) return fail(res, 400, r.err.trim().split("\n").pop() || "Could not parse code");
      return send(res, 200, JSON.parse(r.out));
    }

    return fail(res, 404, "Unknown endpoint");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, 500, e.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  AutoFlow running →  http://localhost:${PORT}`);
  console.log(`  Python          →  ${PYTHON}  (override with PYTHON=...)\n`);
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  for (const r of runs.values()) r.proc?.kill();
  codegenProc?.kill();
  process.exit(0);
});
