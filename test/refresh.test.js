// Deterministic test of the self-heal path: expired token -> refresh -> write-back ->
// probe with the NEW token. Fully isolated: temp HOME (file-source creds, no keychain),
// and https fully mocked (no network). Asserts the stale token is replaced everywhere.
const fs = require("fs");
const path = require("path");

const HOME = "/tmp/uqb_fakehome";
process.env.HOME = HOME;
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
const credPath = path.join(HOME, ".claude", ".credentials.json");

// seed an EXPIRED token (expiresAt 1 min in the past) so the refresh branch must fire
fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: {
  accessToken: "OLD_EXPIRED_TOKEN",
  refreshToken: "OLD_REFRESH",
  expiresAt: Date.now() - 60_000,
  scopes: ["user:inference"],
} }));

// ---- mock vscode + https before requiring the extension ----
const Module = require("module");
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { createStatusBarItem: () => ({ show() {}, hide() {} }) },
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  commands: { registerCommand: () => ({}) },
};
const seen = { refreshAuth: null, refreshBody: null, probeAuth: null };
const httpsStub = {
  request(opts, cb) {
    const isRefresh = opts.hostname === "platform.claude.com";
    let body = "";
    const req = {
      on() { return req; },
      setTimeout() { return req; },
      write(d) { body += d; },
      end() {
        if (isRefresh) {
          seen.refreshBody = body;
          // simulate Anthropic returning a fresh access token + ROTATED refresh token
          const res = mkRes(200, {}, JSON.stringify({
            access_token: "NEW_FRESH_TOKEN", refresh_token: "NEW_REFRESH", expires_in: 28800,
          }));
          cb(res);
        } else {
          seen.probeAuth = opts.headers.authorization;
          // simulate the quota probe succeeding with the new token
          const res = mkRes(200, {
            "anthropic-ratelimit-unified-5h-utilization": "0.20",
            "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now()/1000)+3600),
            "anthropic-ratelimit-unified-7d-utilization": "0.10",
            "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now()/1000)+500000),
          }, "{}");
          cb(res);
        }
      },
    };
    if (isRefresh) seen.refreshAuth = (opts.headers["content-type"] || "");
    return req;
  },
};
function mkRes(status, headers, body) {
  return { statusCode: status, headers, _body: body,
    on(ev, fn) { if (ev === "data") fn(body); if (ev === "end") fn(); return this; } };
}
const origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === "vscode") return vscodeStub;
  if (req === "https") return httpsStub;
  return origLoad.call(this, req, ...a);
};

const ext = require(require("path").join(__dirname,"..","extension.js"));
const I = ext._internal;

(async () => {
  const r = await I.fetchClaude();
  const after = JSON.parse(fs.readFileSync(credPath, "utf8")).claudeAiOauth;

  const checks = [
    ["refresh fired (hit token endpoint)", seen.refreshBody !== null],
    ["refresh body has grant_type+client_id",
      /"grant_type":"refresh_token"/.test(seen.refreshBody || "") &&
      /9d1c250a-e61b-44d9-88ed-5944d1962f5e/.test(seen.refreshBody || "")],
    ["probe used the NEW token", seen.probeAuth === "Bearer NEW_FRESH_TOKEN"],
    ["fetchClaude returned live quota (no error)", !r.error && r.five && r.five.rem === 80],
    ["creds file rewritten: accessToken", after.accessToken === "NEW_FRESH_TOKEN"],
    ["creds file rewritten: rotated refreshToken", after.refreshToken === "NEW_REFRESH"],
    ["creds file expiry pushed ~8h out", after.expiresAt - Date.now() > 7 * 3600 * 1000],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log((pass ? "PASS" : "FAIL") + " — " + name); if (!pass) ok = false; }
  console.log(ok ? "\nALL GREEN ✅" : "\nFAILURES ❌");
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
