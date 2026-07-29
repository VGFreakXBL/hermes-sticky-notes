# Rebuild / customize sticky notes with Hermes

Paste into Hermes Desktop (load the `hermes-desktop-plugins` skill).

---

## Short prompt

```
Build a Hermes Desktop sticky-notes disk plugin at
~/.hermes/desktop-plugins/sticky-notes/plugin.js (id must match folder).

Constraints: imports only @hermes/plugin-sdk, react, react/jsx-runtime;
jsx()/jsxs() only (no JSX syntax); theme CSS vars only (no hardcoded colors);
ctx.storage persistence (profile-scoped).

Core UX:
1. One floating STACK card by default (list + editor). New notes land in stack.
2. Break out = exactly ONE free floating card (never bulk).
3. Drag free floats until they overlap ~40% of area; on pointer-up after a REAL
   drag (not a click), merge into ONE pile window (member list + active body).
4. Split (↗) from pile = exactly one free float; suppress auto-merge ~2s and
   spawn on a different anchor so it isn't instantly re-piled.
5. Stack all = every desk note (free floats + whole piles) returns to main stack
   with pileId cleared.
6. After stacking a pile, breaking out one stack row must only detach that id
   (sanitize: stacked notes never keep pileId; breakOut never treats stale
   pileId as splitFromPile).
7. Topic labels = body/title preview, not blank "Sticky".
8. Status chip + palette + keybinds (⌘⇧N new, ⌘⇧S stack all).
9. Default visibility GLOBAL. Optional session pin only if solid; no project pin.

Verify: load with no error toast; stack → break out 2–3 → drag-pile → stack all
→ break out ONE only; split from pile stays split until user drags again.
Reference: https://github.com/VGFreakXBL/hermes-sticky-notes
```

---

## Longer checklist (same behavior)

### Constraints
- Single file: `~/.hermes/desktop-plugins/sticky-notes/plugin.js`
- Folder name = plugin `id` = `sticky-notes`
- Imports only: `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`
- UI via `jsx()` / `jsxs()` (no JSX syntax)
- Theme vars only — never hardcode colors (`#hex`, `rgb`, etc.)
- Persist with `ctx.storage` (profile-scoped)
- Floating panes: `placement: 'floating'` (+ `anchor`, width/height)

### Core UX
1. **One stack** floating card by default (list + editor for active note)
2. **New** sticky lands in the stack
3. **Break out** creates a free floating card for **exactly one** note
4. **Drag free floats** so they overlap ~40% of area → on release after a **real drag**, **merge into one pile** window (list + active body)
5. **Merge rules (important):**
   - Only merge after pointer moved (not on plain clicks / ↗)
   - After split or break out, suppress auto-merge briefly (~2s)
   - Split should pick a different spawn `anchor` from siblings
6. **Split** (↗) from a pile pulls exactly one note back to a free float
7. **Stack all** / pile “Stack all” returns desk notes to the main stack and **clears `pileId` on every stacked note**
8. Status chip + palette + keybinds (`⌘⇧N` new, `⌘⇧S` stack all)
9. Topic labels = note text preview, not blank “Sticky”
10. Default visibility = **global** (optional session pin only if already solid)

### State hygiene (hard-won)
- Model fields: `surface: 'stack' | 'breakout'`, `pileId: string | null`, `zRank`, optional `sessionId`
- `pileId` is only valid when `surface === 'breakout'`
- On every write: if `surface === 'stack'`, force `pileId = null`
- `breakOut(id)`:
  - from stack → only that id becomes a free breakout
  - `splitFromPile` only if already `surface === 'breakout' && pileId`
  - never bulk-break former pile mates
- Prefer full rebuild of free-float registration order for click-to-front (`zRank`)
- Click handlers on stack/pile chrome: `preventDefault` + `stopPropagation` (avoid click-through when a float unmounts)

### Do not block on
- Project pin / multi-ref
- Fancy paper textures / OS always-on-top
- Agent protocol (optional later: `/sticky …`, `[[sticky]]…[[/sticky]]`)

### Verify
- Settings → Plugins loads without error toast
- Stack → break out 2–3 → drag-overlap pile → stack all → break out **one** only
- Split from pile stays split until the user deliberately drags floats together again
- Reload desktop plugins after each save

Reference implementation: this repo’s [`plugin.js`](./plugin.js).

---
