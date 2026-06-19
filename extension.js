"use strict";
// Usage Quota Bar — Claude Code + Codex subscription quota in the VS Code status bar.
// "Quiet until it matters": one item per provider showing just a colored dot + name
// when on-track, expanding to a window's remaining % + reset only when that window
// has something to say (pace-aware). Icon anchors: ⏱ = 5h session, 🗓 = 7d week.
// No dollars, no tokens. Zero npm deps. Reads local auth at runtime; embeds no secret.

const vscode = require("vscode");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const L = require("./lib");

const CLOCK = "⏱"; // 5h session window
const CAL = "🗓"; // 7d weekly window
const WIN5 = 5 * 3600; // 5h in seconds
const WIN7 = 7 * 24 * 3600; // 7d in seconds

// reveal tuning (see spec). fiveFloor is user-configurable.
// fastMargin 15 (not 5): the linear pace line sits near 100% early in a rolling
// 7d window, so a tight margin falsely reads normal early-week use as "too fast".
// Proper fix is the velocity model (spec §3a); 15 is a pragmatic default for now.
const O7 = { fastMargin: 15, soonFrac: 2 / 7, high: 50, scarce: 25 };

function colorFor(rem) {
  if (rem == null) return new vscode.ThemeColor("charts.yellow");
  if (rem <= 10) return new vscode.ThemeColor("charts.red");
  if (rem <= 30) return new vscode.ThemeColor("charts.yellow");
  return new vscode.ThemeColor("charts.green");
}

// exact wall-clock strings for the tooltip
function clock5(sec) {
  if (sec == null) return "unknown";
  return new Date(Date.now() + sec * 1000).toLocaleTimeString(undefined, {
    hour: "numeric", minute: "2-digit",
  });
}
function clock7(sec) {
  if (sec == null) return "unknown";
  return new Date(Date.now() + sec * 1000)
    .toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
    .replace(",", "");
}

// ---- credential readers --------------------------------------------------
function readClaudeToken() {
  try {
    const p = path.join(os.homedir(), ".claude", ".credentials.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const t = j && j.claudeAiOauth && j.claudeAiOauth.accessToken;
    if (t) return Promise.resolve(t);
  } catch (_) {}
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile("security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        (err, stdout) => {
          if (err) return resolve(null);
          try {
            const j = JSON.parse(stdout.trim());
            resolve((j.claudeAiOauth && j.claudeAiOauth.accessToken) || null);
          } catch (_) { resolve(null); }
        });
    });
  }
  return Promise.resolve(null);
}

function readCodexAuth() {
  try {
    const p = path.join(os.homedir(), ".codex", "auth.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const tokens = j.tokens || j;
    const access = tokens.access_token || j.access_token;
    let account = tokens.account_id || j.account_id || j.accountId;
    if (!account && tokens.id_token) account = L.accountFromJwt(tokens.id_token);
    if (access) return { access, account };
  } catch (_) {}
  return null;
}

// ---- HTTP ----------------------------------------------------------------
function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

// fetchers return { five:{rem,reset,win}, seven:{rem,reset,win} } or { error }
async function fetchClaude() {
  const token = await readClaudeToken();
  if (!token) return { error: "no Claude credentials found" };
  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001", max_tokens: 1,
    messages: [{ role: "user", content: "." }],
  });
  const res = await request({
    method: "POST", hostname: "api.anthropic.com", path: "/v1/messages",
    headers: {
      "content-type": "application/json", "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20", authorization: `Bearer ${token}`,
      "content-length": Buffer.byteLength(body),
    },
  }, body);
  const h = res.headers;
  const fiveUsed = L.parseUtil(h["anthropic-ratelimit-unified-5h-utilization"]);
  const sevenUsed = L.parseUtil(h["anthropic-ratelimit-unified-7d-utilization"]);
  if (fiveUsed == null && sevenUsed == null) return { error: `no quota headers (HTTP ${res.status})` };
  const rem = (u) => (u == null ? null : Math.max(0, Math.round(100 - u)));
  return {
    five: { rem: rem(fiveUsed), reset: L.parseResetHeader(h["anthropic-ratelimit-unified-5h-reset"]), win: WIN5 },
    seven: { rem: rem(sevenUsed), reset: L.parseResetHeader(h["anthropic-ratelimit-unified-7d-reset"]), win: WIN7 },
  };
}

async function fetchCodex() {
  const auth = readCodexAuth();
  if (!auth || !auth.access) return { error: "no Codex credentials found" };
  const headers = { authorization: `Bearer ${auth.access}` };
  if (auth.account) headers["chatgpt-account-id"] = auth.account;
  const res = await request({
    method: "GET", hostname: "chatgpt.com", path: "/backend-api/wham/usage", headers,
  });
  let j;
  try { j = JSON.parse(res.body); } catch (_) { return { error: `bad response (HTTP ${res.status})` }; }
  const rl = j.rate_limit || j; // windows nested under rate_limit
  const p = rl.primary_window || rl.primaryWindow || j.primary_window || {};
  const s = rl.secondary_window || rl.secondaryWindow || j.secondary_window || {};
  if (p.used_percent == null && s.used_percent == null) return { error: `no quota windows (HTTP ${res.status})` };
  const rem = (u) => (u == null ? null : Math.max(0, Math.round(100 - u)));
  return {
    five: { rem: rem(p.used_percent), reset: p.reset_after_seconds, win: p.limit_window_seconds || WIN5 },
    seven: { rem: rem(s.used_percent), reset: s.reset_after_seconds, win: s.limit_window_seconds || WIN7 },
  };
}

// ---- status bar (one item per provider) ----------------------------------
let items = {}; // claude, codex

function renderProvider(it, name, d, fiveFloor) {
  if (d.error) {
    it.text = `⚪ ${name} —`;
    it.color = colorFor(null);
    it.tooltip = `${name}: ${d.error}`;
    return;
  }
  const f = d.five, s = d.seven;
  const worst = Math.min(f.rem == null ? 101 : f.rem, s.rem == null ? 101 : s.rem);
  const parts = [`${L.dotFor(worst === 101 ? null : worst)} ${name}`];
  if (L.reveal5h(f.rem, f.reset, f.win, { floor: fiveFloor, fastMargin: 12 })) {
    parts.push(`${CLOCK} ${f.rem == null ? "—" : f.rem + "%"} (${L.fmtShort(f.reset)})`);
  }
  if (L.reveal7d(s.rem, s.reset, s.win, O7)) {
    parts.push(`${CAL} ${s.rem == null ? "—" : s.rem + "%"} (${L.fmtLong(s.reset)})`);
  }
  it.text = parts.join("  "); // two spaces between windows; icons self-segment
  it.color = colorFor(worst === 101 ? null : worst);
  it.tooltip =
    `${name}\n` +
    `⏱ 5h: ${f.rem == null ? "—" : f.rem + "% left"} · resets ${clock5(f.reset)} (in ${L.fmtShort(f.reset)})\n` +
    `🗓 Weekly resets ${clock7(s.reset)} (${s.rem == null ? "—" : s.rem + "% left"})`;
}

async function refresh() {
  const cfg = vscode.workspace.getConfiguration("usageQuotaBar");
  const fiveFloor = cfg.get("fiveFloor", 50);

  if (cfg.get("showClaude", true)) {
    items.claude.show();
    try { renderProvider(items.claude, "Claude", await fetchClaude(), fiveFloor); }
    catch (e) { renderProvider(items.claude, "Claude", { error: e.message }, fiveFloor); }
  } else items.claude.hide();

  if (cfg.get("showCodex", true)) {
    items.codex.show();
    try { renderProvider(items.codex, "Codex", await fetchCodex(), fiveFloor); }
    catch (e) { renderProvider(items.codex, "Codex", { error: e.message }, fiveFloor); }
  } else items.codex.hide();
}

let timer = null;
function scheduleLoop() {
  if (timer) clearInterval(timer);
  const secs = Math.max(15, vscode.workspace.getConfiguration("usageQuotaBar").get("refreshSeconds", 60));
  timer = setInterval(refresh, secs * 1000);
}

function activate(context) {
  // priority desc => Claude left of Codex on the right side
  items.claude = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  items.codex = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  for (const k of Object.keys(items)) {
    items[k].command = "usageQuotaBar.refresh";
    items[k].text = "…";
    context.subscriptions.push(items[k]);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("usageQuotaBar.refresh", refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("usageQuotaBar")) { scheduleLoop(); refresh(); }
    })
  );
  refresh();
  scheduleLoop();
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
