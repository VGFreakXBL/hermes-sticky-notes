# Rebuild / customize sticky notes with Hermes

Paste into Hermes Desktop (with Desktop plugins skill available):

---

Build or improve a Hermes Desktop **disk plugin** for sticky notes.

### Constraints
- Single file: `~/.hermes/desktop-plugins/sticky-notes/plugin.js`
- Folder name = plugin `id` = `sticky-notes`
- Imports only: `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`
- UI via `jsx()` / `jsxs()` (no JSX syntax)
- Theme vars only — never hardcode colors (`#hex`, `rgb`, etc.)
- Persist with `ctx.storage` (profile-scoped)

### Core UX
1. **One stack** floating card by default (list + editor for active note)
2. **New** sticky lands in the stack
3. **Break out** creates a free floating card for one note
4. **Drag free floats** so they overlap ~40% of area → on release, **merge into one pile** window (list + active body)
5. **Split** (↗) from a pile pulls exactly one note back to a free float (suppress auto-merge briefly)
6. **Stack all** returns desk notes to the main stack
7. Status chip + palette + keybinds (`⌘⇧N` new, `⌘⇧S` stack all)
8. Topic labels = note text preview, not blank “Sticky”
9. Default visibility = **global** (optional session pin only if already solid)

### Do not block on
- Project pin / multi-ref (later)
- Fancy paper textures / always-on-top OS windows
- Agent protocol unless requested

### Verify
- Settings → Plugins loads without error toast
- Stack → break out → pile → stack all → break out **one** only
- Reload desktop plugins after each save

Reference implementation: this repo’s `plugin.js`.

---
