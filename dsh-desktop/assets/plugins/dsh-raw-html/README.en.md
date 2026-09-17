# dsh-raw-html · VCP Visual-Synesthesia Protocol Plugin

**[中文 README](./README.md) · [CHANGELOG](./CHANGELOG.md)**

Brings **VCP (Visual-Synesthesia)** to the DeepSeek Harness Web GUI:
HTML in messages goes from "a blob of source code" to a genuinely rendered interface,
and the agent outputs following a **maintainable design system**.

**Plug & play**: any computer, any agent — install this plugin + toggle the **「</>」switch**
in the browser → the browser renders HTML, the agent follows the design spec
(design principles / Chinese typography / font pairing).

## ✨ Gallery

> VCP cards rendered in real conversations (5 promo banners):

![Banner 1](docs/images/banner-1.jpg)
![Banner 2](docs/images/banner-2.jpg)
![Banner 3](docs/images/banner-3.jpg)
![Banner 4](docs/images/banner-4.jpg)
![Banner 5](docs/images/banner-5.jpg)

## 📣 What's New (EAC v0.6.1)

**2026-08-27**

- **EAC slot integration**: rendering now uses the official
  `conversation.chat.node` / `assistant-step` slot instead of modifying compressed
  `dsh-web-frontend` bundles.
- **Isolation and fallback**: `#vcp-root` cards render in Shadow DOM; ordinary
  messages continue using the official Assistant component, and render failures
  fall back automatically.
- **Opt-in defaults**: HTML rendering and aesthetic injection are disabled until
  the user enables them.
- **Managed distribution**: the EAC-managed copy is not connected to an upstream
  auto-update source, preventing an incompatible upstream bundle from replacing
  the slot adapter.

Earlier `v0.3.0` compatibility and patch notes remain in [CHANGELOG.md](./CHANGELOG.md)
as historical context only.

## Versioning

- **Plugin version**: the `version` in `package.json` (currently **0.6.1**, EAC-managed). No patch codename anymore — rendering is handled through the official `conversation.chat.node` slot without touching the `dsh-web-frontend` bundle.

## Components

| Component | Path | Purpose |
|---|---|---|
| Rendering takeover | `lib/client.js` | Takes over rendering via the official `conversation.chat.node` / `assistant-step` slot: only messages containing `#vcp-root` with rendering enabled are rendered in an isolated Shadow DOM; other messages and render errors fall back to the official component. No `dsh-web-frontend` bundle patching |
| Security filters | `lib/client.js` | `sanitizeVcpHtml`/`sanitizeCss`/`isAllowedUrl`: blocks script/iframe/object/embed tags, `on*` events and `javascript:` protocols; `onclick="input('...')"` whitelist bridge |
| Plugin (host side) | `lib/index.js` | Toggle state (**persisted to disk**) + VCP protocol injected into the system prompt + `/fonts` font service (**built-in + external library dual source**) + shared knowledge (the protocol carries the local DESIGN.md path for any agent) |
| Plugin (browser side) | `lib/client.js` | Injects the **「</>」toggle** next to the composer send button + exposes `window.__dshInput` (VCP button → fill & send) |
| **Built-in fonts** | `assets/fonts/` | **7 open-source fonts (woff2 subsets, ~7.6MB) shipped with the plugin** — WenKai / WenKai Light / MaShanZheng / HeiTi / HeiTi Light / HeiTi Bold / GreatVibes, all OFL-licensed, zero config |
| Design system docs | `DESIGN.md` | Full spec library: font list / palettes / Chinese typography / security iron laws (knowledge layer; agents may read on demand) |
| Security regression tests | repo `dsh-desktop/test/raw-html-sanitize.test.ts` | EAC project-level security tests: validate tag/event/URL/CSS filtering on the new rendering path (jsdom), replacing the removed bundle-injection engine tests |
| Built-in contract tests | repo `dsh-desktop/test/raw-html-integration.test.ts` | Verify slot takeover, opt-in behavior, no bundle injection, and protection from upstream auto-update |
| Subset tool | `tools/subset_fonts.py` | For maintainers: trims new fonts to common-character subsets + woff2 compression (needs Python + fonttools + brotli) |

## Install

### Built into EAC (recommended)

Shipped under `dsh-desktop/assets/plugins/dsh-raw-html/`, synced to the profile with the client and enabled by default; HTML rendering and aesthetic injection are **opt-in** (activated only after the user enables them). No manual patching is required — rendering is handled through the official `conversation.chat.node` slot and never touches the `dsh-web-frontend` bundle.

### Standalone install (other DSH environments)

```powershell
dsh plugin --profile web add "path\to\plugin"
```

No patch script needed; uninstall with `dsh plugin --profile web remove dsh-raw-html`.

## Rendering integration (official EAC slot)

The plugin takes over message rendering through the official `conversation.chat.node` `assistant-step` slot:

- Ordinary messages reuse the official Assistant component.
- Only when a message contains `<div id="vcp-root">` and HTML rendering is enabled is it rendered in an isolated Shadow DOM, wired to KaTeX / Mermaid / built-in fonts.
- Render errors or a disabled toggle fall back to the official component.
- It no longer modifies the `dsh-web-frontend` bundle and does not depend on injected globals (the legacy v6-inject engine has been removed).

## ⚠️ Common pitfall: no blank lines inside vcp-root (important!)

**A markdown HTML block ends at a blank line (`\n\n`)** — if `<div id="vcp-root">` contains two consecutive line breaks, the card is split into multiple nodes: the opening part is auto-completed by DOMParser into a small card with only a top background strip, and the rest overflows outside the background. Symptom: **the dark background only wraps the top strip, and content below has no background** (confirmed 2026-08-19).

**Rules**:
- All children inside vcp-root use **single line breaks** or stay on one line; never leave `\n\n` anywhere;
- Use `margin` for visual grouping, not blank lines;
- After writing, check: the card HTML string must contain zero occurrences of `\n\n`.

## Config

- **Built-in fonts** (recommended): 7 open-source fonts shipped with the plugin (all OFL-licensed), zero config.
- **External font library** (optional): defaults to empty (built-in fonts only). Point `Settings → Plugins → raw-html → fontsRoot` to your own library. Works fine without one: 7 built-in open-source fonts + system fonts as fallback.
- **Toggle state**: persisted at `~/.dsh/dsh-raw-html-state.json`, restored after service restart.

## Usage

- Click **「</> OFF」→「</> ON」** next to the composer send button to enable;
- Once on, HTML in **new messages** renders immediately; historical messages re-render on page refresh;
- The agent receives the injected VCP protocol → automatically outputs `#vcp-root` visual containers; when off, the protocol is withdrawn → the agent falls back to plain Markdown.
- VCP buttons `onclick="input('reply text')"` fill the input and send on click.

## Maintenance / Upgrading

- After each change: `node --check lib/client.js && node --check lib/index.js`; client changes take effect on refresh; host changes require a dsh service restart.
- Since the EAC integration renders through the official slot and never patches `dsh-web-frontend`, a `dsh` upgrade needs no re-patching.
- **Dependency declaration rule** (lesson from the 2026-08-19 crash): every third-party package you `import` **must be declared** in package.json (dependencies or peerDependencies) — relying on whatever node_modules happens to exist is gambling your lifeline. Run `node tools/check-deps.cjs` after each change to verify.
- To improve the design spec → edit `DESIGN.md` (agents read it on demand) + sync the protocol text (`buildProtocolText` in `lib/index.js`).
- To add built-in fonts → edit the FONTS list in `tools/subset_fonts.py` and re-run (needs Python + fonttools + brotli); woff2 subsets are output to `assets/fonts/`.

## Restore (remove plugin)

```powershell
# Remove the plugin; profile bundles are cleaned by EAC's built-in sync.
dsh plugin --profile web remove dsh-raw-html
```

## Security notes

Once enabled, HTML from model output is rendered as UI. The Shadow DOM renderer filters scripts/events/dangerous
protocols (React rendering naturally never executes script; events only allow the controlled
`onclick="input('...')"` channel; `script/iframe/object/embed` and `javascript:` protocols are
dropped), but styles and external images remain reachable — **enable only for trusted models**.
