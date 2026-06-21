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

// Claude OAuth refresh — values lifted verbatim from the Claude Code binary so we
// speak its exact protocol. Claude Code's cached access token expires ~8h out and is
// only refreshed by Claude Code itself; when it sits idle the token goes stale and our
// probe 401s (the "white dot" bug). We refresh it ourselves, but ONLY within REFRESH_GRACE
// of expiry — while Claude Code is active it keeps the token fresh, so this never fires
// then, which means we never race Claude Code's own refresh. The refresh endpoint often
// returns no new refresh_token (no rotation); when it does, we write it back so Claude
// Code stays in sync. Refreshed creds are persisted to the same store we read from.
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // public Claude Code OAuth client
const CLAUDE_TOKEN_HOST = "platform.claude.com";
const CLAUDE_TOKEN_PATH = "/v1/oauth/token";
const REFRESH_GRACE_SEC = 600; // refresh when <10m from expiry (only true when Claude Code is idle)

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
const CLAUDE_FILE = () => path.join(os.homedir(), ".claude", ".credentials.json");
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

// Parse a credentials JSON blob into our shape, tagging where it came from so we can
// write the refreshed token back to the same store. Returns null if unusable.
function parseClaudeCreds(jsonStr, source, account) {
  try {
    const raw = JSON.parse(jsonStr);
    const o = raw.claudeAiOauth || raw;
    if (!o || !o.accessToken) return null;
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken || null,
      expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null, // ms epoch
      raw, source, account,
    };
  } catch (_) { return null; }
}

// Read full Claude creds (token + refresh token + expiry + provenance). File first,
// then macOS Keychain. We also grab the Keychain account name so write-back targets
// the exact same item.
function readClaudeCreds() {
  try {
    const c = parseClaudeCreds(fs.readFileSync(CLAUDE_FILE(), "utf8"), "file", null);
    if (c) return Promise.resolve(c);
  } catch (_) {}
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      (err, secret) => {
        if (err) return resolve(null);
        // separate call (no -w) to recover the account attr for write-back
        execFile("security",
          ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE],
          (e2, attrs) => {
            let account = os.userInfo().username;
            const m = !e2 && /"acct"<blob>="([^"]*)"/.exec(attrs);
            if (m) account = m[1];
            resolve(parseClaudeCreds(secret.trim(), "keychain", account));
          });
      });
  });
}

// Persist refreshed creds back to whichever store we read them from, preserving the
// surrounding JSON shape. Keychain update via `add-generic-password -U` is silent and
// non-destructive (verified). Best-effort: a failed write just means we refresh again
// next cycle. Returns a promise that always resolves.
function writeClaudeCreds(creds, updated) {
  const out = creds.raw && creds.raw.claudeAiOauth ? creds.raw : { claudeAiOauth: {} };
  const t = out.claudeAiOauth || out;
  t.accessToken = updated.accessToken;
  if (updated.refreshToken) t.refreshToken = updated.refreshToken;
  t.expiresAt = updated.expiresAt;
  const json = JSON.stringify(out);
  if (creds.source === "file") {
    try { fs.writeFileSync(CLAUDE_FILE(), json, { mode: 0o600 }); } catch (_) {}
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile("security",
      ["add-generic-password", "-U", "-a", creds.account || os.userInfo().username,
       "-s", CLAUDE_KEYCHAIN_SERVICE, "-w", json],
      () => resolve());
  });
}

// Exchange the refresh token for a fresh access token, write it back, return the new
// token. Single-flight so overlapping refreshes (e.g. fast manual clicks) collapse to one
// network call. Throws on any failure so the caller can fall back to the stale token.
let claudeRefreshInFlight = null;
function refreshClaudeToken(creds) {
  if (!creds.refreshToken) return Promise.reject(new Error("no refresh token"));
  if (claudeRefreshInFlight) return claudeRefreshInFlight;
  claudeRefreshInFlight = (async () => {
    const body = JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    });
    const res = await request({
      method: "POST", hostname: CLAUDE_TOKEN_HOST, path: CLAUDE_TOKEN_PATH,
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "content-length": Buffer.byteLength(body),
      },
    }, body);
    if (res.status !== 200) throw new Error(`refresh HTTP ${res.status}`);
    const j = JSON.parse(res.body);
    if (!j.access_token) throw new Error("refresh: no access_token in response");
    const updated = {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || creds.refreshToken, // omitted => no rotation, keep old
      expiresAt: Date.now() + (j.expires_in ? j.expires_in * 1000 : WIN5 * 1000),
    };
    await writeClaudeCreds(creds, updated);
    return updated.accessToken;
  })();
  return claudeRefreshInFlight.finally(() => { claudeRefreshInFlight = null; });
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
  const creds = await readClaudeCreds();
  if (!creds) return { error: "no Claude credentials found" };
  let token = creds.accessToken;
  // Self-heal the stale-token "white dot": if the cached token is at/near expiry
  // (only happens when Claude Code has been idle), refresh it ourselves before probing.
  let refreshFailed = false;
  if (creds.expiresAt != null && Date.now() >= creds.expiresAt - REFRESH_GRACE_SEC * 1000) {
    try { token = await refreshClaudeToken(creds); }
    catch (_) { refreshFailed = true; }
  }
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
  if (fiveUsed == null && sevenUsed == null) {
    if (refreshFailed || res.status === 401)
      return { error: "token expired — open Claude Code to re-auth" };
    return { error: `no quota headers (HTTP ${res.status})` };
  }
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
// test hooks (VS Code only invokes activate/deactivate; exposing these is harmless and
// lets the credential/refresh paths be exercised without a VS Code host).
module.exports._internal = { readClaudeCreds, refreshClaudeToken, fetchClaude, parseClaudeCreds };
