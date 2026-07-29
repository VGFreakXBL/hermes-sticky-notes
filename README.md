# Hermes Sticky Notes

In-Desktop sticky / post-it notes for **[Hermes Desktop](https://hermes-agent.nousresearch.com/)**, built as a single disk plugin (no app fork, no build step).

One **stack** on the glass. **Break out** notes when they need ambient space. **Drag floats together** to pile them. **Stack all** when the desk gets loud.

> v0.1 — global stickies by default. Session pin exists as a light toggle; project pin may come later.

## Install

Requires **Hermes Desktop** (the Electron app). CLI/gateway alone will not load this.

```bash
mkdir -p ~/.hermes/desktop-plugins/sticky-notes
curl -fsSL -o ~/.hermes/desktop-plugins/sticky-notes/plugin.js \
  https://raw.githubusercontent.com/VGFreakXBL/hermes-sticky-notes/main/plugin.js
```

Or copy manually:

```bash
mkdir -p ~/.hermes/desktop-plugins/sticky-notes
cp plugin.js ~/.hermes/desktop-plugins/sticky-notes/plugin.js
```

Then in Desktop:

1. **⌘K → Reload desktop plugins** (or wait a few seconds for the file watcher)
2. **Settings → Plugins** → enable **Sticky Notes** if it’s off
3. Look for the status chip `sticky` and the floating **stickies** stack card

Named profiles: install under `~/.hermes/profiles/<name>/desktop-plugins/sticky-notes/` instead when that profile is active.

## How to use

| Action | How |
|--------|-----|
| New sticky | Status chip, stack **New**, palette **Sticky: New (stack)**, or `⌘⇧N` |
| Edit | Select a row in the stack; body autosaves |
| Break out | **↗** on a stack row or **Break out** in the editor |
| Pile | Drag free breakout windows until they **overlap ~40%**, then **release** |
| Flip inside a pile | Click a row in the pile list |
| Split from pile | **↗** on a pile row |
| Return one to stack | **↙ stack** on a breakout, or **↙** in a pile |
| Stack everything | **Stack all** / `⌘⇧S` / palette |
| Clear all | Palette **Sticky: Clear all** (destructive) |

Notes persist in plugin-scoped storage (`ctx.storage`), profile-aware. No real filesystem access.

## Design notes

- One stack card by default (not one float per note)
- Overlap-merge only after a real drag (not on plain clicks)
- Short grace after split so notes aren’t immediately re-piled
- Themes: no hardcoded colors — uses app CSS variables
- Disk plugin rules: `jsx()` / `jsxs()` only; imports limited to `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`

## Agent (best-effort)

If the gateway event payload includes plain text, markers like these may create notes:

```text
/sticky remember to check the PR
[[sticky]]
Half-baked idea
body here
[[/sticky]]
```

Treat agent authoring as experimental in v0.1 — demo the manual UX first.

## Customize with Hermes

See [PROMPT.md](./PROMPT.md) for a rebuild / fork prompt you can paste into Hermes.

## License

MIT — see [LICENSE](./LICENSE).

Built against the Hermes Desktop Plugin SDK. Not affiliated with Nous Research beyond using the public plugin surface.
