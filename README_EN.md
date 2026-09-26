# Onceglance

<p align="center">
  <img src="assets/logo/png/appicon-windows-512.png" alt="Onceglance Logo" width="120" height="120" />
</p>

<p align="center">
  <b>Let AI agents see your screen, and turn your workflow into tutorials.</b><br />
  AI-native screenshot tool · Windows-first · Local-first · No Telemetry
</p>

<p align="center">
  English | <a href="README.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%2010%2F11-lightgrey.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/Version-v0.1.1-green.svg" alt="Version" />
  <img src="https://img.shields.io/badge/Language-Rust%20%2B%20TypeScript-orange.svg" alt="Language" />
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License" />
</p>

---

**Onceglance** is an AI-native screenshot tool for Windows: any agent that speaks MCP or shell (Claude, Codex, Cursor, etc.) can complete the full perception pipeline — *capture → OCR → annotate → persist* — through standardized interfaces. For humans, it is a keyboard-friendly screenshot & pin tool; for agents, it is the standard gateway to your machine's visual capabilities.

- **Local-first**: everyday features run entirely on-device, with zero telemetry. Optional AI enhancement is bring-your-own-key — keys are encrypted in the OS credential store, screenshots are only sent when you explicitly trigger it, and every call lands in the audit log.
- **One core, three frontends**: GUI, CLI and MCP share the same kernel — install once, use it three ways.
- **No daemon required**: agents can call capture, OCR and annotation even when the GUI is not running.

## ✨ Features

- **📸 Smart capture**: region selection with automatic window/widget detection, window & fullscreen capture, multi-monitor physical-pixel support. Resident viewfinder overlay: ~44ms from hotkey to dimmed screen.
- **🖍️ Pro annotation**: draw directly on the frozen screen — arrow / rectangle / ellipse / numbered step / text / highlight / mosaic / crop, with 8 keyboard shortcuts and undo. Saves go through a deterministic renderer; derived images never overwrite the original.
- **🔤 On-device OCR**: Windows.Media.Ocr engine, fully offline. Returns text blocks with bounding boxes and confidence; OCR results are linked to image coordinates in the main panel.
- **📜 Scrolling capture**: release-to-capture, scroll-through collection with frame-stability detection, automatic stitch seam QA page.
- **📌 Pin to screen**: pin captures back onto the screen with drag, wheel zoom and opacity control.
- **🤖 Agent-ready**: `once` CLI with JSON output on every command + stdio MCP Server. Annotation parameters inherit the theme remembered by the GUI client whenever the agent doesn't pass explicit values.
- **🛡️ Privacy guardrails**: agent master switch + silent-capture switch + privacy app blocklist (password managers & banking apps are rejected on hit — no "allow once") + metadata-only audit log (auto-cleaned after 30 days).

## 🚀 Installation

### 1. Desktop client (GUI)

Download the latest `onceglance` client package from [Releases](https://github.com/wample0105/apo-once-glance/releases) and unzip it.

- **Requirements**: Windows 10 (19045+) / Windows 11, WebView2 Runtime (bundled with Win11).

### 2. CLI & Agent Skill (one command)

```bash
curl -fsSL --retry 3 https://github.com/wample0105/apo-once-glance/releases/latest/download/install.sh | bash
```

Downloads the platform-specific `once` CLI with SHA-256 verification into `~/.onceglance/bin`, and installs the `onceglance-tutorial` skill into the common Agent Skills directory. Verify with `once status --json`.

### 3. MCP integration (one-click from the client)

Open the client's **Agent** page → click "Connect" for Claude Desktop / Claude Code / Cursor / Codex / ZCode, etc. The MCP config is written automatically (original files are backed up first). You can also add `once mcp` to your MCP config manually.

## 📝 Usage

### Keyboard (for humans)

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+A` | Region capture |
| `Alt+Shift+W` | Window capture |
| `Alt+Shift+F` | Fullscreen capture |
| `Alt+Shift+T` | OCR |
| `Alt+Shift+L` | Scrolling capture |
| `Alt+Shift+H` | Open main panel |

### Command line (for agents)

```bash
once status                  # instance / storage / OCR / hotkey status
once capture window --json   # capture foreground window
once ocr last --json         # OCR: text blocks + bounding boxes
once annotate last --script s.json --out r.png   # instruction-driven annotation
once history --query "kind:window"               # search history
once mcp                     # stdio MCP server
```

Every command prints a unified JSON envelope (`{ok, data, error, meta}`). Exit codes are frozen: `0` success / `1` usage / `2` capture / `3` OCR / `4` IO / `5` permission / `6` blocklist.

MCP tools: `capture_screen` / `ocr_image` / `annotate_image` / `list_history` / `doctor`.

## ❓ FAQ

- **Screenshots look washed out / overexposed?**
  HDR is enabled. Under HDR, Windows composites the desktop in high dynamic range, and legacy capture APIs receive a tone-mapped frame. Fix: Settings → System → Display → HDR → off.
- **Can agents call it while the client is closed?**
  Yes. CLI/MCP are standalone frontends to the same kernel; capture/OCR/annotation/history all work without the GUI. Only interactive region selection and scrolling capture need it.
- **Does the blocklist stop manual region capture?**
  No — the blocklist targets agent-initiated and hotkey-triggered captures (when you're not watching). Manual selection is a deliberate act by you, consistent with other tools.
- **Do derived images overwrite originals?**
  Never. All annotated/cropped outputs are written as `-ann` files with a lineage manifest; deletions go to the Recycle Bin.

## 🗑️ Uninstall

1. Client: quit from the tray and delete the app folder; captures live in `Pictures\Onceglance`.
2. CLI: delete `~/.onceglance`.
3. MCP config: click "Remove" on the Agent page for each connected client.

## ☕ Connect & Support

If Onceglance helps you, follow for updates, join the community, or buy the author a coffee.

<table align="center">
  <tr>
    <td align="center"><b>WeChat Official Account</b></td>
    <td align="center"><b>WeChat</b></td>
    <td align="center"><b>Support</b></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/cta/apo-rpa-qrcode.png" alt="Apo RPA QR code" width="180" /></td>
    <td align="center"><img src="assets/cta/apo-wechat-qrcode.png" alt="Apo WeChat QR code" width="180" /></td>
    <td align="center"><img src="assets/cta/apo-donate-qrcode.png" alt="Donate QR code" width="180" /></td>
  </tr>
  <tr>
    <td align="center"><b>Apo RPA</b><br />Latest releases & handy tools (Chinese)</td>
    <td align="center"><b>Apo</b><br />Send "OnceGlance" to join the users group</td>
    <td align="center"><b>Buy me a coffee</b><br />Optional donation, much appreciated</td>
  </tr>
</table>

<p align="center">Click an image to view it full-size; long-press or right-click to save.</p>

## 🛠 Development

```bash
npm install
npm run build        # output in src-tauri/target/release/
npm run dev          # dev mode
cargo test -p once-core   # kernel unit tests
```

```text
src-tauri/
├─ src/                # desktop shell: windows/tray/hotkeys/viewfinder/delivery/scroll-capture/pins
└─ crates/
   ├─ once-core/       # kernel: capture/OCR/annotation/scroll-stitch/history/storage/clipboard/blocklist/audit
   └─ once-cli/        # once CLI + MCP server
ui/                    # web frontend (main panel / viewfinder / toast / seam QA), no build step
docs/                  # read-only specs (PRD / UI design / interaction spec)
handoff.md             # dev handoff log: requirements, decisions and verification per iteration
```

Issues and PRs are welcome; see `handoff.md` for conventions and current status.

## 📄 License

[MIT](LICENSE) © Apo

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/wample0105">Apo</a>
</p>
