# Usage Quota Bar — Claude Code + Codex

A tiny VS Code status-bar indicator for your **Claude Code** and **Codex**
**subscription** quota — the rolling **5-hour** and **7-day** windows — shown as
**% remaining**. It's *quiet until it matters*: each
provider is one item that shows just a colored dot when you're fine, and speaks up
only when a window is worth knowing about - either you're using your plan too quickly or your usage is low (regardless of time left in the window)

```
on track:        🟢 Claude            🟢 Codex
worth knowing:   🟢 Claude            🟡 Codex  ⏱ 12% (4h19m)  🗓 84% (6d)
```

- **⏱ = 5h** session window · **🗓 = 7d** weekly window — distinct icons so you read them at a glance.
- **Dot** = the worse of the two windows: 🟢 >30% · 🟡 ≤30% · 🔴 ≤10% remaining.
- **Hover** a provider for exact resets, e.g. `Weekly resets Fri 12:59 PM`.

### ▶ Try it live (no install)

**[Open the interactive demo →](https://achromichat.github.io/usage-quota-bar/)** — drag
the sliders and watch the status bar react, with a panel that explains *why* each
window shows or hides. (Mirrors the real logic exactly.)

### When does a window appear? (pace-aware)

It stays hidden while you're on track, and reveals when:

- **5h:** at/under the floor (default **50%**) **or** you're burning faster than pace
  (so a hot burn shows even above 50%).
- **7d:** burning too fast for the week, **or** you've a surplus you'll waste before
  reset (use-it-or-lose-it), **or** genuinely scarce (≤25%).

## Install

1. Download the latest `usage-quota-bar-X.Y.Z.vsix` from the
   [**Releases**](https://github.com/achromichat/usage-quota-bar/releases) page.
2. In VS Code: `Cmd/Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick the file.
   (Or from a terminal: `code --install-extension usage-quota-bar-X.Y.Z.vsix`.)
3. Reload the window. The items appear on the right of the status bar.

## Requirements

You need to be **logged in locally** to whichever you want to track:

- **Claude Code** — reads `~/.claude/.credentials.json` (or the macOS Keychain item
  `Claude Code-credentials`).
- **Codex** — reads `~/.codex/auth.json`.

If a provider isn't set up, just turn it off with `usageQuotaBar.showClaude` /
`usageQuotaBar.showCodex`.

## Settings

| Setting | Default | What |
|---|---|---|
| `usageQuotaBar.refreshSeconds` | `60` | Refresh interval (min 15). |
| `usageQuotaBar.fiveFloor` | `50` | 5h reveals at/below this % remaining. |
| `usageQuotaBar.showClaude` | `true` | Show the Claude item. |
| `usageQuotaBar.showCodex` | `true` | Show the Codex item. |

## Privacy & honest caveats

- **No telemetry, no servers of mine.** Your credentials are read locally and used
  only to ask each provider for *your own* quota.
- **It uses each provider's own usage endpoint:** a 1-token `POST` to
  `api.anthropic.com` to read rate-limit headers (so it makes a tiny API call each
  refresh), and a `GET` to ChatGPT's usage endpoint for Codex.
- **These are unofficial/internal endpoints.** They can change or break without
  notice — if numbers stop showing, that's the likely cause (open an issue).
- Zero npm dependencies — just the VS Code API + Node built-ins.

## Build from source

No npm/vsce needed — a `.vsix` is just a zip:

```bash
npm test          # run the unit tests (plain node, no deps)
./build-vsix.sh   # produces usage-quota-bar-<version>.vsix
```

## License

[MIT](./LICENSE)
