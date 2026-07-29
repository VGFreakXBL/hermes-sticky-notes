/**
 * sticky-notes — in-Desktop post-it notes
 *
 * Default: ONE floating stack card. Notes live in the stack unless broken out
 * or pinned as their own floating card.
 *
 * Path: ~/.hermes/desktop-plugins/sticky-notes/plugin.js
 */

import {
  Badge,
  Button,
  EmptyState,
  KEYBINDS_AREA,
  PALETTE_AREA,
  PANES_AREA,
  ScrollArea,
  STATUSBAR_AREAS,
  Textarea,
  Tip,
  atom,
  cn,
  haptic,
  host,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'sticky-notes'
const STORAGE_KEY = 'notes'
const MAX_BREAKOUT = 6
const STACK_PANE_ID = 'stack'
const STACK_ANCHOR = 'top-right'

const TINTS = {
  classic: 'color-mix(in srgb, var(--ui-accent) 20%, transparent)',
  soft: 'color-mix(in srgb, var(--ui-text-secondary) 10%, transparent)',
  ghost: 'transparent'
}

/**
 * surface:
 *   'stack'    — main stickies stack card
 *   'breakout' — on the desk (alone or in a pile)
 * pileId: null = free float; string = shared pile window (overlap-merge)
 * zRank: raise order on desk / within a pile
 *
 * @typedef {{
 *   id: string,
 *   title: string,
 *   body: string,
 *   tint: 'classic' | 'soft' | 'ghost',
 *   rotation: number,
 *   open: boolean,
 *   surface: 'stack' | 'breakout',
 *   pileId: string | null,
 *   zRank: number,
 *   sessionId: string | null,
 *   createdAt: number,
 *   updatedAt: number,
 *   author: 'user' | 'agent',
 *   model?: string,
 *   anchor?: string
 * }} StickyNote
 */

const $notes = atom(/** @type {StickyNote[]} */ ([]))
const $ready = atom(false)
/** Which stacked note is expanded in the main stack card */
const $activeStackId = atom(/** @type {string | null} */ (null))
/** pileId → active note id inside that pile window */
const $activePileNote = atom(/** @type {Record<string, string>} */ ({}))

const OVERLAP_MERGE = 0.42
const MERGE_COOLDOWN_MS = 600
/** After split/breakout, block auto-merge so new floats aren't sucked back in. */
const SPLIT_MERGE_GRACE_MS = 2200
let lastMergeAt = 0
let mergeSuppressedUntil = 0
/** Only merge after a real drag (not a click on ↗). */
let deskDragMoved = false
let deskPointerDown = false

function suppressMerge(ms = SPLIT_MERGE_GRACE_MS) {
  mergeSuppressedUntil = Math.max(mergeSuppressedUntil, Date.now() + ms)
}

function pickBreakoutAnchor() {
  const a = BREAKOUT_ANCHORS[breakoutAnchorCursor % BREAKOUT_ANCHORS.length]
  breakoutAnchorCursor += 1
  return a
}

function pickAnchorAwayFrom(other) {
  const idx = BREAKOUT_ANCHORS.indexOf(other)
  if (idx < 0) return pickBreakoutAnchor()
  return BREAKOUT_ANCHORS[(idx + 1) % BREAKOUT_ANCHORS.length]
}

/** @type {import('@hermes/plugin-sdk').PluginContext | null} */
let pluginCtx = null
/** @type {Map<string, () => void>} */
const paneDisposers = new Map()
/** @type {Array<() => void>} */
const lifetimeDisposers = []
let persistTimer = null
let liveGen = 0
let breakoutAnchorCursor = 0
const BREAKOUT_ANCHORS = ['top-left', 'bottom-right', 'bottom-left', 'top-right']

function uid() {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function migrateNote(raw) {
  if (!raw || typeof raw !== 'object') return null
  const n = /** @type {Record<string, unknown>} */ (raw)
  const surface =
    n.surface === 'breakout' || n.surface === 'stack'
      ? n.surface
      : // legacy MVP used open:true per-note floats — fold them into the stack
        'stack'
  return {
    id: String(n.id || uid()),
    title: String(n.title || 'Sticky'),
    body: String(n.body || ''),
    tint: n.tint === 'soft' || n.tint === 'ghost' ? n.tint : 'classic',
    rotation: typeof n.rotation === 'number' ? n.rotation : 0,
    open: n.open !== false,
    surface,
    // pileId only valid while on the desk
    pileId:
      surface === 'breakout' && typeof n.pileId === 'string' && n.pileId
        ? n.pileId
        : null,
    zRank: typeof n.zRank === 'number' ? n.zRank : 0,
    sessionId: typeof n.sessionId === 'string' ? n.sessionId : null,
    createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
    updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : Date.now(),
    author: n.author === 'agent' ? 'agent' : 'user',
    model: typeof n.model === 'string' ? n.model : undefined,
    anchor: typeof n.anchor === 'string' ? n.anchor : undefined
  }
}

function loadNotes() {
  if (!pluginCtx) return
  const raw = pluginCtx.storage.get(STORAGE_KEY, [])
  const byId = new Map()
  for (const item of Array.isArray(raw) ? raw : []) {
    const n = migrateNote(item)
    if (!n) continue
    // Backfill topics for legacy "Sticky" titles that already have body text
    let note = n
    if (isDefaultTitle(note.title) && oneLine(note.body)) {
      const line = oneLine(note.body)
      note = {
        ...note,
        title: line.length > 48 ? `${line.slice(0, 47)}…` : line
      }
    }
    // Hard sanitize: stack ⇒ no pile; non-breakout ⇒ no pile
    if (note.surface === 'stack' || note.surface !== 'breakout') {
      note = { ...note, pileId: null }
    }
    byId.set(note.id, note)
  }
  const list = [...byId.values()]
  $notes.set(/** @type {StickyNote[]} */ (list))
  pluginCtx.storage.set(STORAGE_KEY, list)
  $ready.set(true)
  const stacked = list.filter(n => n.open && n.surface === 'stack')
  if (stacked.length && !$activeStackId.get()) {
    $activeStackId.set(stacked.sort((a, b) => b.updatedAt - a.updatedAt)[0].id)
  }
}

function schedulePersist() {
  if (!pluginCtx) return
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    pluginCtx?.storage.set(STORAGE_KEY, $notes.get())
  }, 200)
}

function getNote(id) {
  return $notes.get().find(n => n.id === id) || null
}

function sessionOk(n) {
  if (!n.sessionId) return true
  return host.state.activeSessionId.get() === n.sessionId
}

function stackedNotes() {
  return $notes
    .get()
    .filter(n => n.open && n.surface === 'stack' && sessionOk(n))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** All desk notes (free floats + pile members). */
function breakoutNotes() {
  return $notes
    .get()
    .filter(n => n.open && n.surface === 'breakout' && sessionOk(n))
    .sort((a, b) => (a.zRank || 0) - (b.zRank || 0) || a.createdAt - b.createdAt)
}

/** Solo floating cards (not in a pile). */
function freeBreakouts() {
  return breakoutNotes().filter(n => !n.pileId)
}

function notesInPile(pileId) {
  return breakoutNotes().filter(n => n.pileId === pileId)
}

function uniquePileIds() {
  const ids = new Set()
  for (const n of breakoutNotes()) {
    if (n.pileId) ids.add(n.pileId)
  }
  return [...ids]
}

function nextZRank(scopePileId) {
  const pool = $notes
    .get()
    .filter(
      n =>
        n.surface === 'breakout' &&
        (scopePileId ? n.pileId === scopePileId : !n.pileId)
    )
  let max = 0
  for (const n of pool) max = Math.max(max, n.zRank || 0)
  return max + 1
}

function setActivePileNote(pileId, noteId) {
  $activePileNote.set({ ...$activePileNote.get(), [pileId]: noteId })
}

/**
 * Raise a free float to front (DOM order), or raise within its pile.
 */
function focusBreakout(id) {
  const n = getNote(id)
  if (!n || n.surface !== 'breakout' || !n.open) return

  if (n.pileId) {
    setActivePileNote(n.pileId, id)
    const rank = nextZRank(n.pileId)
    $notes.set($notes.get().map(x => (x.id === id ? { ...x, zRank: rank } : x)))
    schedulePersist()
    return
  }

  const ordered = freeBreakouts()
  const top = ordered[ordered.length - 1]
  if (top && top.id === id) return
  const rank = nextZRank(null)
  $notes.set($notes.get().map(x => (x.id === id ? { ...x, zRank: rank } : x)))
  schedulePersist()
  rebuildBreakoutPanes(true)
}

// ── Overlap → pile merge ────────────────────────────────────────────────────

function readDeskRects() {
  if (typeof document === 'undefined') return []
  /** @type {{ kind: 'float' | 'pile', id: string, r: DOMRect }[]} */
  const out = []
  document.querySelectorAll('[data-floating-pane]').forEach(el => {
    const raw = el.getAttribute('data-floating-pane') || ''
    const r = el.getBoundingClientRect()
    if (r.width < 12 || r.height < 12) return
    const floatM = raw.match(/(?:^|:)float-(.+)$/)
    const pileM = raw.match(/(?:^|:)pile-(.+)$/)
    if (floatM) out.push({ kind: 'float', id: floatM[1], r })
    if (pileM) out.push({ kind: 'pile', id: pileM[1], r })
  })
  return out
}

function overlapFrac(a, b) {
  const x1 = Math.max(a.left, b.left)
  const y1 = Math.max(a.top, b.top)
  const x2 = Math.min(a.right, b.right)
  const y2 = Math.min(a.bottom, b.bottom)
  const w = x2 - x1
  const h = y2 - y1
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  const minArea = Math.min(a.width * a.height, b.width * b.height)
  return minArea > 0 ? inter / minArea : 0
}

/** Resolve desk entity → note ids currently in it. */
function entityNoteIds(ent) {
  if (ent.kind === 'float') {
    const n = getNote(ent.id)
    return n && n.surface === 'breakout' && !n.pileId ? [n.id] : []
  }
  return notesInPile(ent.id).map(n => n.id)
}

function mergeNoteIds(ids) {
  const unique = [...new Set(ids)].filter(id => getNote(id))
  if (unique.length < 2) return false

  // Prefer an existing pileId among members; else mint from front-most note.
  const members = unique.map(id => getNote(id)).filter(Boolean)
  const existingPile = members.find(n => n.pileId)?.pileId
  const front = members.slice().sort((a, b) => (a.zRank || 0) - (b.zRank || 0)).pop()
  const pileId = existingPile || `p_${front.id}`
  const topRank = nextZRank(pileId)

  $notes.set(
    $notes.get().map(n => {
      if (!unique.includes(n.id)) return n
      return {
        ...n,
        surface: 'breakout',
        pileId,
        zRank: n.id === front.id ? topRank : n.zRank || 0,
        updatedAt: Date.now()
      }
    })
  )
  setActivePileNote(pileId, front.id)
  schedulePersist()
  rebuildBreakoutPanes(true)
  haptic('tap')
  host.notify({
    kind: 'info',
    message: `Pile · ${unique.length} stickies (click to flip · ↗ splits)`
  })
  return true
}

/** After drag ends: overlapping free floats / piles compile into one pile. */
function maybeMergeOverlapping() {
  const now = Date.now()
  if (now < mergeSuppressedUntil) return
  if (now - lastMergeAt < MERGE_COOLDOWN_MS) return
  // Clicks (split ↗, stack, etc.) must not merge — only a drag that moved.
  if (!deskDragMoved) return
  deskDragMoved = false

  const rects = readDeskRects()
  if (rects.length < 2) return

  // Union-find style merge of overlapping entities
  const parent = new Map(rects.map((_, i) => [i, i]))
  const find = i => {
    let p = parent.get(i)
    while (p !== parent.get(p)) p = parent.get(p)
    parent.set(i, p)
    return p
  }
  const unite = (i, j) => {
    const a = find(i)
    const b = find(j)
    if (a !== b) parent.set(a, b)
  }

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (overlapFrac(rects[i].r, rects[j].r) >= OVERLAP_MERGE) unite(i, j)
    }
  }

  /** @type {Map<number, number[]>} */
  const groups = new Map()
  for (let i = 0; i < rects.length; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(i)
  }

  let merged = false
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue
    const noteIds = []
    for (const i of idxs) noteIds.push(...entityNoteIds(rects[i]))
    if (new Set(noteIds).size >= 2) {
      if (mergeNoteIds(noteIds)) merged = true
    }
  }
  if (merged) {
    lastMergeAt = now
    // Brief grace so follow-up layout thrash doesn't double-merge
    suppressMerge(400)
  }
}

function dissolvePileIfSingleton(pileId, opts = {}) {
  const rebuild = opts.rebuild !== false
  const members = notesInPile(pileId)
  if (members.length !== 1) return
  const only = members[0]
  $notes.set(
    $notes.get().map(n =>
      n.id === only.id ? { ...n, pileId: null, zRank: nextZRank(null) } : n
    )
  )
  const ap = { ...$activePileNote.get() }
  delete ap[pileId]
  $activePileNote.set(ap)
  schedulePersist()
  if (rebuild) rebuildBreakoutPanes(true)
}

/**
 * Split one note out of a pile onto its own float.
 * Suppress auto-merge afterward — otherwise pointerup re-sucks it into the pile
 * (new float spawns on/near the old pile rect).
 */
function splitFromPile(id) {
  const n = getNote(id)
  if (!n?.pileId) return
  const pileId = n.pileId
  const siblings = notesInPile(pileId).filter(x => x.id !== id)
  const siblingAnchor = siblings[0]?.anchor || null

  suppressMerge(SPLIT_MERGE_GRACE_MS)
  deskDragMoved = false

  const splitAnchor = pickAnchorAwayFrom(siblingAnchor || n.anchor || 'top-left')

  // 1) Pull this note out
  // 2) If one sibling left, dissolve pile so both are free floats (different anchors)
  $notes.set(
    $notes.get().map(x => {
      if (x.id === id) {
        return {
          ...x,
          pileId: null,
          zRank: nextZRank(null),
          anchor: splitAnchor,
          updatedAt: Date.now()
        }
      }
      if (siblings.length === 1 && x.id === siblings[0].id) {
        return {
          ...x,
          pileId: null,
          zRank: nextZRank(null),
          // keep existing anchor so it tends to stay put vs the split note
          anchor: x.anchor || siblingAnchor || 'top-right',
          updatedAt: Date.now()
        }
      }
      return x
    })
  )

  if (siblings.length === 1 || siblings.length === 0) {
    const ap = { ...$activePileNote.get() }
    delete ap[pileId]
    $activePileNote.set(ap)
  } else {
    // pile continues with remaining members
    const rest = notesInPile(pileId)
    if (rest.length && $activePileNote.get()[pileId] === id) {
      setActivePileNote(pileId, rest[rest.length - 1].id)
    }
  }

  schedulePersist()
  rebuildBreakoutPanes(true)
  haptic('tap')
  host.notify({
    kind: 'info',
    message: siblings.length ? 'Split from pile' : 'Note unpinned'
  })
}

/** Default placeholder titles we should not treat as a real topic. */
function isDefaultTitle(title) {
  const t = (title || '').trim()
  if (!t) return true
  return /^sticky(\s*#?\s*\d+)?$/i.test(t)
}

function oneLine(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Human label for list rows / pane chrome: custom title, else first body line.
 * @param {{ title?: string, body?: string }} n
 * @param {number} [max]
 */
function noteTopic(n, max = 48) {
  const title = oneLine(n?.title)
  const body = oneLine(n?.body)
  let topic = !isDefaultTitle(title) ? title : body || 'Empty note'
  if (topic.length > max) topic = `${topic.slice(0, Math.max(1, max - 1))}…`
  return topic
}

/**
 * Secondary preview under the topic (body when title is custom; else empty).
 * @param {{ title?: string, body?: string }} n
 * @param {number} [max]
 */
function noteSubpreview(n, max = 56) {
  const title = oneLine(n?.title)
  const body = oneLine(n?.body)
  if (!body) return ''
  if (isDefaultTitle(title)) return '' // topic already is the body
  if (body === title) return ''
  return body.length > max ? `${body.slice(0, Math.max(1, max - 1))}…` : body
}

/**
 * When body is edited and title is still default, promote first line → title
 * so storage itself carries a useful topic.
 */
function maybePromoteTitle(id, body) {
  const n = getNote(id)
  if (!n || !isDefaultTitle(n.title)) return
  const line = oneLine(body)
  if (!line) return
  const title = line.length > 48 ? `${line.slice(0, 47)}…` : line
  // Direct patch without looping promote
  $notes.set(
    $notes.get().map(x =>
      x.id === id ? { ...x, title, body, updatedAt: Date.now() } : x
    )
  )
  schedulePersist()
  syncPanes()
}

function updateNotes(mutator) {
  const next = mutator($notes.get().slice())
  // Sanitize + dedupe by id (last write wins)
  const byId = new Map()
  for (const n of next) {
    if (!n?.id) continue
    let x = n
    // Stack notes must never keep a pile membership
    if (x.surface === 'stack' && x.pileId) x = { ...x, pileId: null }
    // Pile membership only valid on the desk
    if (x.surface !== 'breakout' && x.pileId) x = { ...x, pileId: null }
    byId.set(x.id, x)
  }
  $notes.set([...byId.values()])
  schedulePersist()
  syncPanes()
}

function createNote(opts = {}) {
  const sessionId = opts.sessionLinked ? host.state.activeSessionId.get() : null
  const body = (opts.body || '').trim()
  const explicitTitle = (opts.title || '').trim()
  const title =
    explicitTitle ||
    (body ? (oneLine(body).length > 48 ? `${oneLine(body).slice(0, 47)}…` : oneLine(body)) : '')
  /** @type {StickyNote} */
  const note = {
    id: uid(),
    title: title || 'Sticky',
    body,
    tint: 'classic',
    rotation: 0,
    open: true,
    surface: 'stack',
    pileId: null,
    zRank: 0,
    sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    author: opts.author || 'user',
    model: host.state.model.get() || undefined
  }
  updateNotes(list => list.concat(note))
  $activeStackId.set(note.id)
  haptic('tap')
  host.notify({
    kind: 'info',
    message: note.author === 'agent' ? 'Agent sticky → stack' : 'Sticky added to stack'
  })
  return note
}

function patchNote(id, patch) {
  updateNotes(list =>
    list.map(n => (n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n))
  )
}

function removeNote(id) {
  updateNotes(list => list.filter(n => n.id !== id))
  if ($activeStackId.get() === id) {
    const next = stackedNotes()[0]
    $activeStackId.set(next ? next.id : null)
  }
}

function clearAll() {
  for (const id of [...paneDisposers.keys()]) disposePane(id)
  $notes.set([])
  $activeStackId.set(null)
  schedulePersist()
  host.notify({ kind: 'info', message: 'All stickies cleared' })
}

function stackAll() {
  updateNotes(list =>
    list.map(n =>
      n.open
        ? { ...n, surface: 'stack', pileId: null, rotation: 0, updatedAt: Date.now() }
        : n
    )
  )
  $activePileNote.set({})
  const top = stackedNotes()[0]
  if (top) $activeStackId.set(top.id)
  host.notify({ kind: 'info', message: 'All stickies stacked' })
  haptic('tap')
}

/** Return every note in a pile (by pileId) to the main stack — not just the rendered members snapshot. */
function stackPile(pileId) {
  if (!pileId) return
  updateNotes(list =>
    list.map(n =>
      n.pileId === pileId
        ? { ...n, surface: 'stack', pileId: null, rotation: 0, updatedAt: Date.now() }
        : n
    )
  )
  const ap = { ...$activePileNote.get() }
  delete ap[pileId]
  $activePileNote.set(ap)
  const top = stackedNotes()[0]
  if (top) $activeStackId.set(top.id)
  haptic('tap')
}

/**
 * Put exactly one note on the desk as a free float.
 * Never bulk-breaks. Stale pileId on a stacked note is cleared, not treated as split.
 */
function breakOut(id) {
  const n = getNote(id)
  if (!n || !n.open) return

  // Already on the desk inside a pile → split that one only
  if (n.surface === 'breakout' && n.pileId) {
    splitFromPile(id)
    return
  }

  // Already a free float → just raise it
  if (n.surface === 'breakout' && !n.pileId) {
    focusBreakout(id)
    return
  }

  // From main stack: exactly this id becomes a free breakout
  if (freeBreakouts().length + uniquePileIds().length >= MAX_BREAKOUT) {
    host.notify({ kind: 'info', message: `Breakout cap ${MAX_BREAKOUT}` })
    return
  }

  suppressMerge(SPLIT_MERGE_GRACE_MS)
  deskDragMoved = false

  updateNotes(list =>
    list.map(x => {
      if (x.id !== id) {
        // belt-and-suspenders: stacked notes never keep pileId
        if (x.surface === 'stack' && x.pileId) return { ...x, pileId: null }
        return x
      }
      return {
        ...x,
        surface: 'breakout',
        pileId: null,
        // Fresh corner each breakout so former pile-mates don't stack on one spawn point
        anchor: pickBreakoutAnchor(),
        rotation: 0,
        zRank: nextZRank(null),
        updatedAt: Date.now()
      }
    })
  )
  haptic('tap')
}

function pinSeparate(id) {
  breakOut(id)
}

function returnToStack(id) {
  const n = getNote(id)
  if (!n) return
  const pileId = n.pileId

  // Exactly this note home. If it left a 1-note pile, dissolve that leftover
  // to a free float (not bulk).
  updateNotes(list =>
    list.map(x =>
      x.id === id
        ? { ...x, surface: 'stack', pileId: null, rotation: 0, updatedAt: Date.now() }
        : x
    )
  )
  $activeStackId.set(id)

  if (pileId) {
    const left = $notes
      .get()
      .filter(x => x.open && x.surface === 'breakout' && x.pileId === pileId)
    if (left.length === 1) {
      // Singleton orphan pile → free float (one note), not multi-break
      dissolvePileIfSingleton(pileId)
    } else if (left.length === 0) {
      const ap = { ...$activePileNote.get() }
      delete ap[pileId]
      $activePileNote.set(ap)
    }
  }
  haptic('tap')
}

function dumpNotesText() {
  const notes = $notes.get()
  if (!notes.length) return '(no stickies)'
  return notes
    .map(
      (n, i) =>
        `${i + 1}. [${n.open ? n.surface : 'parked'}] ${noteTopic(n, 80)}\n   ${n.body || '(empty)'}\n   id=${n.id}`
    )
    .join('\n\n')
}

function disposePane(id) {
  const dispose = paneDisposers.get(id)
  if (!dispose) return
  try {
    dispose()
  } catch {
    /* ignore */
  }
  paneDisposers.delete(id)
}

/** Last chrome title per desk pane — refresh when topic changes. */
const breakoutChromeTitle = new Map()
let lastBreakoutOrderKey = ''

function rebuildBreakoutPanes(force = false) {
  if (!pluginCtx) return

  const free = freeBreakouts()
  const pileIds = uniquePileIds()

  // Dissolve singleton piles before layout (no nested rebuild)
  for (const pid of [...pileIds]) {
    if (notesInPile(pid).length <= 1) dissolvePileIfSingleton(pid, { rebuild: false })
  }
  const piles = uniquePileIds()

  const wantIds = new Set([
    ...free.map(n => `float-${n.id}`),
    ...piles.map(pid => `pile-${pid}`)
  ])
  const orderKey = [
    ...free.map(n => `f:${n.id}:${noteTopic(n, 36)}:${n.zRank || 0}`),
    ...piles.map(pid => {
      const mem = notesInPile(pid)
      const active =
        $activePileNote.get()[pid] || mem[mem.length - 1]?.id || ''
      return `p:${pid}:${mem.length}:${active}:${noteTopic(getNote(active) || mem[0] || {}, 24)}`
    })
  ].join('|')

  for (const id of [...paneDisposers.keys()]) {
    if ((id.startsWith('float-') || id.startsWith('pile-')) && !wantIds.has(id)) {
      disposePane(id)
      breakoutChromeTitle.delete(id)
    }
  }

  const allPresent = [...wantIds].every(id => paneDisposers.has(id))
  if (!force && allPresent && orderKey === lastBreakoutOrderKey) return

  // Rebuild free floats (DOM order = zRank)
  for (const n of free) {
    disposePane(`float-${n.id}`)
    breakoutChromeTitle.delete(`float-${n.id}`)
  }
  for (const note of free) {
    const paneId = `float-${note.id}`
    const chrome = noteTopic(note, 36)
    const noteId = note.id
    const dispose = pluginCtx.register({
      id: paneId,
      area: PANES_AREA,
      title: chrome,
      data: {
        placement: 'floating',
        anchor: note.anchor || 'top-left',
        width: '248px',
        height: '200px'
      },
      render: () => jsx(BreakoutCard, { noteId })
    })
    paneDisposers.set(paneId, dispose)
    breakoutChromeTitle.set(paneId, chrome)
  }

  // Rebuild piles
  for (const pid of piles) {
    disposePane(`pile-${pid}`)
    breakoutChromeTitle.delete(`pile-${pid}`)
  }
  for (const pileId of piles) {
    const mem = notesInPile(pileId)
    if (!mem.length) continue
    const activeId =
      $activePileNote.get()[pileId] && mem.some(m => m.id === $activePileNote.get()[pileId])
        ? $activePileNote.get()[pileId]
        : mem[mem.length - 1].id
    if ($activePileNote.get()[pileId] !== activeId) setActivePileNote(pileId, activeId)
    const top = getNote(activeId) || mem[mem.length - 1]
    const paneId = `pile-${pileId}`
    const chrome = `pile · ${mem.length} · ${noteTopic(top, 22)}`
    const dispose = pluginCtx.register({
      id: paneId,
      area: PANES_AREA,
      title: chrome,
      data: {
        placement: 'floating',
        anchor: top.anchor || 'top-left',
        width: '280px',
        height: '300px'
      },
      render: () => jsx(PileCard, { pileId })
    })
    paneDisposers.set(paneId, dispose)
    breakoutChromeTitle.set(paneId, chrome)
  }

  lastBreakoutOrderKey = orderKey
}

function syncPanes() {
  if (!pluginCtx) return

  const want = new Set([STACK_PANE_ID])
  for (const n of freeBreakouts()) want.add(`float-${n.id}`)
  for (const pid of uniquePileIds()) want.add(`pile-${pid}`)

  for (const id of [...paneDisposers.keys()]) {
    if (id === STACK_PANE_ID) continue
    if (!want.has(id)) {
      disposePane(id)
      breakoutChromeTitle.delete(id)
    }
  }

  if (!paneDisposers.has(STACK_PANE_ID)) {
    const dispose = pluginCtx.register({
      id: STACK_PANE_ID,
      area: PANES_AREA,
      title: 'stickies',
      data: {
        placement: 'floating',
        anchor: STACK_ANCHOR,
        width: '280px',
        height: '320px'
      },
      render: () => jsx(StackCard, {})
    })
    paneDisposers.set(STACK_PANE_ID, dispose)
  }

  rebuildBreakoutPanes(false)
}

// ── Stack card (single default float) ───────────────────────────────────────

function StackCard() {
  const t = usePluginI18n(ID)
  const notes = useValue($notes)
  const activeId = useValue($activeStackId)
  const ready = useValue($ready)

  const stacked = notes
    .filter(n => n.open && n.surface === 'stack' && sessionOk(n))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const deskNotes = notes.filter(n => n.open && n.surface === 'breakout' && sessionOk(n))
  const deskWindows =
    deskNotes.filter(n => !n.pileId).length +
    new Set(deskNotes.filter(n => n.pileId).map(n => n.pileId)).size
  const active = stacked.find(n => n.id === activeId) || stacked[0] || null

  useEffect(() => {
    if (active && activeId !== active.id) $activeStackId.set(active.id)
    if (!active && activeId) $activeStackId.set(null)
  }, [active, activeId])

  if (!ready) {
    return jsx('div', {
      className: 'p-3 text-xs text-(--ui-text-tertiary)',
      children: t('loading')
    })
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col gap-2 p-2',
    style: {
      background: 'color-mix(in srgb, var(--ui-accent) 12%, transparent)'
    },
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1',
        'data-floating-no-drag': true,
        children: [
          jsx('div', {
            className: 'min-w-0 flex-1 text-xs font-medium text-(--ui-text-secondary)',
            children: t('stackTitle', stacked.length, deskWindows)
          }),
          jsx(Button, {
            size: 'xs',
            variant: 'ghost',
            onClick: () => createNote({}),
            children: t('new')
          }),
          deskWindows
            ? jsx(Button, {
                size: 'xs',
                variant: 'ghost',
                onClick: stackAll,
                children: t('stackAll')
              })
            : null
        ]
      }),

      stacked.length === 0
        ? jsx('div', {
            className: 'flex min-h-0 flex-1 items-center justify-center',
            children: jsx(EmptyState, {
              title: t('emptyTitle'),
              description: t('emptyBody'),
              className: 'min-h-24'
            })
          })
        : jsxs('div', {
            className: 'flex min-h-0 flex-1 flex-col gap-2',
            children: [
              jsx(ScrollArea, {
                className: 'max-h-24 shrink-0',
                children: jsx('div', {
                  className: 'flex flex-col gap-0.5 pr-1',
                  'data-floating-no-drag': true,
                  children: stacked.map((n, i) => {
                    const topic = noteTopic(n, 40)
                    const sub = noteSubpreview(n, 48)
                    return jsxs(
                      'button',
                      {
                        type: 'button',
                        className: cn(
                          'flex items-start gap-1 rounded px-1.5 py-1 text-left text-[0.7rem] transition-colors',
                          n.id === (active && active.id)
                            ? 'bg-(--chrome-action-hover) text-(--ui-text-secondary)'
                            : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
                        ),
                        onClick: () => $activeStackId.set(n.id),
                        title: oneLine(n.body) || topic,
                        children: [
                          jsx('span', {
                            className: 'w-3 shrink-0 pt-0.5 text-(--ui-text-quaternary)',
                            children: String(i + 1)
                          }),
                          jsxs('span', {
                            className: 'min-w-0 flex-1',
                            children: [
                              jsx('span', {
                                className: 'block truncate font-medium text-(--ui-text-secondary)',
                                children: topic
                              }),
                              sub
                                ? jsx('span', {
                                    className: 'block truncate text-[0.62rem] text-(--ui-text-quaternary)',
                                    children: sub
                                  })
                                : null
                            ]
                          }),
                          n.author === 'agent'
                            ? jsx(Badge, { size: 'xs', children: 'a' })
                            : null,
                          jsx(Tip, {
                            label: t('breakOut'),
                            children: jsx('span', {
                              role: 'button',
                              className:
                                'shrink-0 px-1 pt-0.5 text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
                              onMouseDown: e => {
                                e.preventDefault()
                                e.stopPropagation()
                              },
                              onClick: e => {
                                e.preventDefault()
                                e.stopPropagation()
                                breakOut(n.id)
                              },
                              children: '↗'
                            })
                          }),
                          jsx(Tip, {
                            label: t('delete'),
                            children: jsx('span', {
                              role: 'button',
                              className:
                                'shrink-0 px-1 pt-0.5 text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
                              onClick: e => {
                                e.stopPropagation()
                                removeNote(n.id)
                              },
                              children: '×'
                            })
                          })
                        ]
                      },
                      n.id
                    )
                  })
                })
              }),
              active
                ? jsx(StackEditor, { noteId: active.id })
                : null
            ]
          }),

      deskWindows
        ? jsx('div', {
            className: 'text-[0.6rem] text-(--ui-text-quaternary)',
            'data-floating-no-drag': true,
            children: t('breakoutHint', deskWindows)
          })
        : null
    ]
  })
}

function StackEditor({ noteId }) {
  const t = usePluginI18n(ID)
  const notes = useValue($notes)
  const note = notes.find(n => n.id === noteId)
  const [draft, setDraft] = useState(note?.body || '')
  const timer = useRef(null)

  useEffect(() => {
    setDraft(note?.body || '')
  }, [note?.body, noteId])

  const saveBody = useCallback(
    value => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        patchNote(noteId, { body: value })
        maybePromoteTitle(noteId, value)
      }, 280)
    },
    [noteId]
  )

  if (!note) return null

  const titlePlaceholder = isDefaultTitle(note.title)
    ? noteTopic({ title: '', body: draft || note.body }, 40)
    : t('titlePh')

  return jsxs('div', {
    className: 'flex min-h-0 flex-1 flex-col gap-1.5 rounded-md border border-(--ui-stroke-secondary) p-2',
    style: { background: TINTS[note.tint] || TINTS.classic },
    'data-floating-no-drag': true,
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [
          jsx('input', {
            className: cn(
              'min-w-0 flex-1 bg-transparent text-xs font-medium outline-none',
              'text-(--ui-text-secondary) placeholder:text-(--ui-text-quaternary)'
            ),
            value: isDefaultTitle(note.title) ? '' : note.title,
            placeholder: titlePlaceholder || t('titlePh'),
            onChange: e => patchNote(noteId, { title: e.target.value || 'Sticky' })
          }),
          jsx(Button, {
            size: 'xs',
            variant: 'ghost',
            onMouseDown: e => {
              e.preventDefault()
              e.stopPropagation()
            },
            onClick: e => {
              e.preventDefault()
              e.stopPropagation()
              breakOut(noteId)
            },
            children: t('breakOut')
          })
        ]
      }),
      jsx(Textarea, {
        value: draft,
        placeholder: t('bodyPh'),
        className: cn(
          'min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-sm shadow-none',
          'text-(--ui-text-secondary) focus-visible:ring-0'
        ),
        onChange: e => {
          setDraft(e.target.value)
          saveBody(e.target.value)
        },
        onBlur: e => {
          patchNote(noteId, { body: e.target.value })
          maybePromoteTitle(noteId, e.target.value)
        }
      }),
      jsxs('div', {
        className: 'flex flex-wrap gap-1 text-[0.6rem] text-(--ui-text-quaternary)',
        children: [
          jsx('button', {
            type: 'button',
            className: 'hover:text-(--ui-text-tertiary)',
            onClick: () => {
              const keys = /** @type {Array<'classic' | 'soft' | 'ghost'>} */ (Object.keys(TINTS))
              const i = keys.indexOf(note.tint)
              patchNote(noteId, { tint: keys[(i + 1) % keys.length] })
            },
            children: note.tint
          }),
          jsx('button', {
            type: 'button',
            className: 'hover:text-(--ui-text-tertiary)',
            onClick: () => {
              const sid = host.state.activeSessionId.get()
              const linking = !note.sessionId
              patchNote(noteId, { sessionId: linking ? sid : null })
            },
            children: note.sessionId ? 'session' : 'global'
          })
        ]
      })
    ]
  })
}

// ── Pile window (overlap-merged breakouts) ──────────────────────────────────

function PileCard({ pileId }) {
  const t = usePluginI18n(ID)
  const notes = useValue($notes)
  const activeMap = useValue($activePileNote)
  const members = notes
    .filter(n => n.open && n.surface === 'breakout' && n.pileId === pileId && sessionOk(n))
    .sort((a, b) => (b.zRank || 0) - (a.zRank || 0) || b.updatedAt - a.updatedAt)

  const activeId =
    (activeMap[pileId] && members.some(m => m.id === activeMap[pileId])
      ? activeMap[pileId]
      : members[0]?.id) || null
  const note = members.find(m => m.id === activeId) || members[0]
  const [draft, setDraft] = useState(note?.body || '')
  const timer = useRef(null)

  useEffect(() => {
    setDraft(note?.body || '')
  }, [note?.body, note?.id])

  if (!members.length || !note) {
    return jsx('div', {
      className: 'p-3 text-xs text-(--ui-text-quaternary)',
      children: t('missing')
    })
  }

  const save = value => {
    patchNote(note.id, { body: value })
    maybePromoteTitle(note.id, value)
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col gap-1.5 p-2',
    style: { background: TINTS[note.tint] || TINTS.classic },
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1',
        'data-floating-no-drag': true,
        children: [
          jsx(Badge, { size: 'xs', children: `${members.length}` }),
          jsx('div', {
            className: 'min-w-0 flex-1 truncate text-[0.7rem] font-medium text-(--ui-text-secondary)',
            children: t('pileTitle', members.length)
          }),
          jsx(Button, {
            size: 'xs',
            variant: 'ghost',
            onMouseDown: e => {
              // Prevent click-through to stack UI after this pane unmounts
              e.preventDefault()
              e.stopPropagation()
            },
            onClick: e => {
              e.preventDefault()
              e.stopPropagation()
              // Resolve by pileId from live state — not a stale members snapshot
              stackPile(pileId)
            },
            children: t('stackAll')
          })
        ]
      }),
      jsx(ScrollArea, {
        className: 'max-h-20 shrink-0',
        children: jsx('div', {
          className: 'flex flex-col gap-0.5 pr-1',
          'data-floating-no-drag': true,
          children: members.map((m, i) =>
            jsxs(
              'button',
              {
                type: 'button',
                className: cn(
                  'flex items-center gap-1 rounded px-1.5 py-1 text-left text-[0.68rem]',
                  m.id === note.id
                    ? 'bg-(--chrome-action-hover) text-(--ui-text-secondary)'
                    : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
                ),
                onClick: () => focusBreakout(m.id),
                children: [
                  jsx('span', {
                    className: 'w-3 text-(--ui-text-quaternary)',
                    children: String(i + 1)
                  }),
                  jsx('span', {
                    className: 'min-w-0 flex-1 truncate font-medium',
                    children: noteTopic(m, 36)
                  }),
                  jsx(Tip, {
                    label: t('splitPile'),
                    children: jsx('span', {
                      role: 'button',
                      className: 'px-1 text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
                      onClick: e => {
                        e.stopPropagation()
                        splitFromPile(m.id)
                      },
                      children: '↗'
                    })
                  }),
                  jsx(Tip, {
                    label: t('returnStack'),
                    children: jsx('span', {
                      role: 'button',
                      className: 'px-1 text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
                      onClick: e => {
                        e.stopPropagation()
                        returnToStack(m.id)
                      },
                      children: '↙'
                    })
                  })
                ]
              },
              m.id
            )
          )
        })
      }),
      jsx(Textarea, {
        value: draft,
        placeholder: t('bodyPh'),
        className: cn(
          'min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-sm shadow-none',
          'text-(--ui-text-secondary) focus-visible:ring-0'
        ),
        'data-floating-no-drag': true,
        onChange: e => {
          setDraft(e.target.value)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => save(e.target.value), 280)
        },
        onBlur: e => save(e.target.value)
      })
    ]
  })
}

// ── Breakout / pinned separate card ─────────────────────────────────────────
// Pane chrome already shows noteTopic() — no second title row. One body field.

function BreakoutCard({ noteId }) {
  const t = usePluginI18n(ID)
  const notes = useValue($notes)
  const note = notes.find(n => n.id === noteId)
  const [draft, setDraft] = useState(note?.body || '')
  const timer = useRef(null)

  useEffect(() => {
    setDraft(note?.body || '')
  }, [note?.body, noteId])

  if (!note) {
    return jsx('div', {
      className: 'p-3 text-xs text-(--ui-text-quaternary)',
      children: t('missing')
    })
  }

  const save = value => {
    patchNote(noteId, { body: value })
    maybePromoteTitle(noteId, value)
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col gap-1 p-2',
    style: {
      background: TINTS[note.tint] || TINTS.classic
    },
    onPointerDown: () => focusBreakout(noteId),
    children: [
      jsxs('div', {
        className: 'flex items-center justify-end gap-0.5',
        'data-floating-no-drag': true,
        children: [
          jsx(Tip, {
            label: t('returnStack'),
            children: jsx('button', {
              type: 'button',
              className:
                'rounded px-1.5 py-0.5 text-[0.65rem] text-(--ui-text-quaternary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary)',
              onClick: () => returnToStack(noteId),
              children: '↙ stack'
            })
          }),
          jsx(Tip, {
            label: t('delete'),
            children: jsx('button', {
              type: 'button',
              className:
                'rounded px-1.5 py-0.5 text-[0.65rem] text-(--ui-text-quaternary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary)',
              onClick: () => removeNote(noteId),
              children: '×'
            })
          })
        ]
      }),
      jsx(Textarea, {
        value: draft,
        placeholder: t('bodyPh'),
        className: cn(
          'min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-sm shadow-none',
          'text-(--ui-text-secondary) placeholder:text-(--ui-text-quaternary) focus-visible:ring-0'
        ),
        'data-floating-no-drag': true,
        onChange: e => {
          setDraft(e.target.value)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => save(e.target.value), 280)
        },
        onBlur: e => save(e.target.value)
      })
    ]
  })
}

function StatusChip() {
  const t = usePluginI18n(ID)
  const notes = useValue($notes)
  const open = notes.filter(n => n.open).length
  const desk =
    notes.filter(n => n.open && n.surface === 'breakout' && !n.pileId).length +
    new Set(
      notes.filter(n => n.open && n.surface === 'breakout' && n.pileId).map(n => n.pileId)
    ).size

  return jsx(Tip, {
    label: t('chipTip'),
    children: jsx('button', {
      type: 'button',
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: () => createNote({}),
      children: desk ? `sticky ${open}·${desk}↗` : open ? `sticky ${open}` : 'sticky'
    })
  })
}

// ── Agent protocol ──────────────────────────────────────────────────────────

function parseStickyCommand(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  let m = trimmed.match(/^\/?sticky\s+(clear|list|dump|stack)\s*$/i)
  if (m) return { op: m[1].toLowerCase() }
  m = trimmed.match(/^\/?sticky(?:\s+create)?\s+([\s\S]+)$/i)
  if (m) return { op: 'create', body: m[1].trim() }
  m = trimmed.match(/\[\[sticky\]\]\s*([\s\S]*?)\s*\[\[\/sticky\]\]/i)
  if (m) return { op: 'create', body: m[1].trim(), author: 'agent' }
  m = trimmed.match(/<!--\s*sticky:\s*([^|>]+?)\s*\|\s*([\s\S]*?)\s*-->/i)
  if (m) return { op: 'create', title: m[1].trim(), body: m[2].trim(), author: 'agent' }
  return null
}

function extractText(payload) {
  if (!payload || typeof payload !== 'object') return null
  const p = /** @type {Record<string, unknown>} */ (payload)
  for (const key of ['text', 'content', 'message', 'body']) {
    const v = p[key]
    if (typeof v === 'string' && v.length < 4000) return v
  }
  if (p.message && typeof p.message === 'object') {
    const msg = /** @type {Record<string, unknown>} */ (p.message)
    if (typeof msg.content === 'string') return msg.content
    if (typeof msg.text === 'string') return msg.text
  }
  if (p.payload && typeof p.payload === 'object') return extractText(p.payload)
  if (p.data && typeof p.data === 'object') return extractText(p.data)
  return null
}

function handleAgentProtocol(event) {
  try {
    const text = extractText(event)
    if (!text || text.length > 2000 && !/\[\[sticky\]\]|<!--\s*sticky:/.test(text)) return
    if (!/sticky/i.test(text) && !/\[\[sticky\]\]/i.test(text) && !/<!--\s*sticky:/i.test(text)) return
    const cmd = parseStickyCommand(text)
    if (!cmd) return
    if (cmd.op === 'clear') return clearAll()
    if (cmd.op === 'stack') return stackAll()
    if (cmd.op === 'list' || cmd.op === 'dump') {
      return host.notify({ kind: 'info', title: 'Stickies', message: dumpNotesText().slice(0, 400) })
    }
    if (cmd.op === 'create' && cmd.body) {
      const lines = cmd.body.split('\n')
      const title = cmd.title || (lines[0].length < 48 ? lines[0] : 'Sticky')
      const body = cmd.title
        ? cmd.body
        : lines[0].length < 48 && lines.length > 1
          ? lines.slice(1).join('\n')
          : cmd.body
      createNote({ title, body, author: cmd.author || 'agent' })
    }
  } catch (err) {
    console.error('[sticky-notes]', err)
  }
}

// ── Plugin export ───────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Sticky Notes',
  register(ctx) {
    pluginCtx = ctx
    liveGen += 1
    const gen = liveGen

    for (const id of [...paneDisposers.keys()]) disposePane(id)
    for (const d of lifetimeDisposers.splice(0)) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }

    ctx.i18n.register({
      en: {
        stackTitle: (stacked, out) =>
          out ? `Stickies · ${stacked} stacked · ${out} out` : `Stickies · ${stacked}`,
        chipTip: 'New sticky (adds to stack)',
        new: 'New',
        stackAll: 'Stack all',
        breakOut: 'Break out',
        returnStack: 'Return to stack',
        delete: 'Delete',
        titlePh: 'Title',
        bodyPh: 'Write something…',
        loading: 'Loading…',
        emptyTitle: 'Empty stack',
        emptyBody: 'New adds a note here. Break out (↗) pins a separate float. Drag floats together to pile.',
        missing: 'Missing',
        breakoutHint: n => `${n} on desk — Stack all to collapse`,
        pinnedHint: 'Pinned separate · ↙ returns to stack',
        pileTitle: n => `Pile · ${n}`,
        splitPile: 'Split from pile'
      }
    })

    loadNotes()
    // Fold any leftover multi-float chaos: force non-breakout open notes into stack
    updateNotes(list =>
      list.map(n =>
        n.open && n.surface !== 'breakout' ? { ...n, surface: 'stack', rotation: 0 } : n
      )
    )
    // updateNotes already syncs — but load path:
    syncPanes()

    lifetimeDisposers.push(
      host.state.activeSessionId.listen(() => {
        if (liveGen !== gen) return
        syncPanes()
      })
    )
    lifetimeDisposers.push(
      host.onEvent('*', ev => {
        if (liveGen !== gen) return
        handleAgentProtocol(ev)
      })
    )

    // Desk drag → merge on release. Clicks alone must not merge.
    if (typeof window !== 'undefined') {
      let downX = 0
      let downY = 0
      const onDown = e => {
        if (liveGen !== gen) return
        deskPointerDown = true
        deskDragMoved = false
        downX = e.clientX
        downY = e.clientY
      }
      const onMove = e => {
        if (liveGen !== gen || !deskPointerDown) return
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) {
          deskDragMoved = true
        }
      }
      const onUp = () => {
        if (liveGen !== gen) return
        deskPointerDown = false
        // Defer so floating-pane position persistence finishes first
        setTimeout(() => {
          if (liveGen !== gen) return
          maybeMergeOverlapping()
        }, 100)
      }
      window.addEventListener('pointerdown', onDown, true)
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      lifetimeDisposers.push(() => {
        window.removeEventListener('pointerdown', onDown, true)
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
      })
    }

    // No docked right board — stack float is the home surface.
    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 125,
      render: () => jsx(StatusChip, {})
    })

    ctx.registerMany([
      {
        id: 'cmd-new',
        area: PALETTE_AREA,
        data: {
          id: 'sticky-notes.new',
          label: 'Sticky: New (stack)',
          keywords: ['sticky', 'note', 'new'],
          run: () => createNote({})
        }
      },
      {
        id: 'cmd-stack-all',
        area: PALETTE_AREA,
        data: {
          id: 'sticky-notes.stack-all',
          label: 'Sticky: Stack all',
          keywords: ['sticky', 'stack', 'collapse'],
          run: () => stackAll()
        }
      },
      {
        id: 'cmd-dump',
        area: PALETTE_AREA,
        data: {
          id: 'sticky-notes.dump',
          label: 'Sticky: Dump all (toast)',
          keywords: ['sticky', 'list'],
          run: () =>
            host.notify({ kind: 'info', title: 'Stickies', message: dumpNotesText().slice(0, 500) })
        }
      },
      {
        id: 'cmd-clear',
        area: PALETTE_AREA,
        data: {
          id: 'sticky-notes.clear',
          label: 'Sticky: Clear all',
          keywords: ['sticky', 'clear'],
          run: () => clearAll()
        }
      },
      {
        id: 'key-new',
        area: KEYBINDS_AREA,
        data: {
          id: 'sticky-notes.new',
          label: 'New sticky (stack)',
          category: 'Sticky Notes',
          defaults: ['mod+shift+n'],
          run: () => createNote({})
        }
      },
      {
        id: 'key-stack',
        area: KEYBINDS_AREA,
        data: {
          id: 'sticky-notes.stack-all',
          label: 'Stack all stickies',
          category: 'Sticky Notes',
          defaults: ['mod+shift+s'],
          run: () => stackAll()
        }
      }
    ])
  }
}
