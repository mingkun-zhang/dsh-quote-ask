/**
 * dsh-quote-ask — Host half.
 *
 * The browser half owns the right-sidebar tab, the selection menu and the
 * conversation surface. Two things cannot be done from a browser page:
 *
 *   1. Creating the isolated scratch working directory a side chat runs in.
 *      A side chat session is created with `cwd` = `$DSH_HOME/quote-ask/<id>
 *      /workspace`; under the default `workspace-write` sandbox that directory
 *      is the only place the session's file tools may write, which is what
 *      makes "delete everything the side chat created" a directory delete
 *      instead of a guess about user files.
 *
 *   2. Deleting the durable artifacts a session produces. DSH 0.2.1-rc.2 has
 *      no session-deletion API (session-persistence and workspace both say so
 *      explicitly), so the only way to honour "files are removed when the side
 *      chat exits" is to delete the exact, bounded artifacts of the sessions
 *      this plugin created:
 *        - `$DSH_HOME/sessions/--<projectKey(cwd)>--/<encodeSegment(id)>/`
 *        - `$DSH_HOME/storages/session_projcache/sessions/<id>.json`
 *        - `%TEMP%/dsh-spill-<root>/session-<sha256(id)[0:12]>`
 *        - the quote-ask directory itself (scratch workspace, marker, journal)
 *
 * Ownership rules (the host runs with the user's own privileges, so every
 * deletion path must prove it is ours):
 *
 *   - all targets live under four fixed roots (`$DSH_HOME/sessions`,
 *     `$DSH_HOME/storages/session_projcache`, `$DSH_HOME/quote-ask`,
 *     `%TEMP%/dsh-spill-*`);
 *   - ids and every path segment are validated before use, and containment is
 *     re-checked immediately before each deletion;
 *   - a session's files are deleted only when its ownership is proven:
 *       a) `bind` compared the live session's cwd with the scratch directory, or
 *       b) the session log exists in the bucket derived from that scratch cwd, or
 *       c) the projection-cache record's `identity.cwd` equals the scratch cwd;
 *   - symbol links / junctions are never followed (final component is unlinked);
 *   - a cleanup obligation is journaled before deletion and only retired after
 *     a boot-time verification pass, so a session disposed after our delete
 *     (which rewrites its projection cache) cannot leave a permanent orphan.
 *
 * Routes (absolute paths; reachable through the Desktop preload bridge and from
 * the same-origin Web page; every route is behind the connection trust fence):
 *   POST /dsh-quote-ask/prepare   { sideChatId, mainSessionId? } -> { dir }
 *   POST /dsh-quote-ask/bind      { sideChatId, sessionId }      -> { dir }
 *   POST /dsh-quote-ask/touch     { sideChatId }                 -> { ok }
 *   POST /dsh-quote-ask/cleanup   { sideChatId?, sessionId? }    -> { removed, failed }
 *   GET  /dsh-quote-ask/ping                                     -> status
 *
 * @module dsh-quote-ask
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Package/row name; also the client module id and the right-sidebar tab id. */
export const name = 'dsh-quote-ask'

/** Absolute route prefix (works both over HTTP and through the Electron bridge). */
const ROUTE = '/dsh-quote-ask'
/** DSH home; the same resolution the shipped plugins use. */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** Plugin-private root. Everything the plugin writes lives below it. */
const SIDE_ROOT = join(DSH_HOME, 'quote-ask')
/** Durable session logs root (`session-persistence-jsonl.root` in the desktop profile). */
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
/** Projection cache root (`storage-json.root` + `session-projcache`). */
const PROJCACHE_DIR = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
/** Pending cleanup journal; an entry survives until a boot-time verification pass. */
const JOURNAL_PATH = join(SIDE_ROOT, 'journal.json')
/** Per-quote-ask model-only context file; injected through the system prompt, never rendered in the chat. */
const CONTEXT_FILE = 'context.md'
/** Upper bound for the rendered main-conversation transcript kept in the context file. */
const MAX_CONTEXT_CHARS = 600000
/** Byte cap for reading a context file back (Chinese text is 3 bytes per char). */
const MAX_CONTEXT_FILE_BYTES = 16 * 1024 * 1024
/** Upper bound for one quoted selection. */
const MAX_QUOTE_CHARS = 12000
/** Upper bound for the number of quotes one side chat keeps. */
const MAX_QUOTES = 50
/** Pending "添加至对话" quote states, one JSON file per main session. Never a quote-ask directory. */
const MAIN_QUOTES_DIR = join(SIDE_ROOT, 'main-quotes')
/** Upper bound for one main-conversation attachment list. */
const MAX_MAIN_QUOTES = 20
/** Ids this plugin mints are uuids; this is the deletion-target whitelist. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Names reserved by the plugin's own root (never a quote-ask directory). */
const RESERVED_SIDE_IDS = new Set(['journal.json', 'main-quotes'])
/** Largest request body accepted by a route. Anchor data can include a full quoted message. */
const MAX_BODY_BYTES = 1024 * 1024
/** A prepared-but-never-bound side chat older than this is a crash leftover. */
const ORPHAN_AGE_MS = 60 * 60 * 1000
/** A quote-ask directory without a marker file older than this is a crash leftover. */
const MARKERLESS_AGE_MS = 24 * 60 * 60 * 1000
/** UUID shape of a quote-ask id (used to gate markerless-directory reaping). */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/* ------------------------------------------------------------------------- *
 * Small filesystem helpers. All of them either prove a path is one of ours or
 * refuse to touch it.
 * ------------------------------------------------------------------------- */

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {any} ctx @param {string} text */
function warn(ctx, text) {
  try {
    ctx?.logger?.warn?.(`[dsh-quote-ask] ${text}`)
  } catch {
    /* logging must never break a cleanup */
  }
}

/** Ids accepted from the browser half / marker files. */
function isSafeId(value) {
  return typeof value === 'string'
    && SAFE_ID.test(value)
    && !/[ .]$/.test(value)
    && !RESERVED_SIDE_IDS.has(value)
}

/** Strict containment: `target` must be a descendant of `root`, never `root`. */
function inside(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (r === t) return false
  const prefix = r.endsWith(sep) ? r : r + sep
  return process.platform === 'win32'
    ? t.toLowerCase().startsWith(prefix.toLowerCase())
    : t.startsWith(prefix)
}

/** Compare two paths the way the host filesystem compares them. */
function samePath(left, right) {
  try {
    const a = resolve(String(left))
    const b = resolve(String(right))
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}

/** True for a real directory on disk that is not a symlink/junction. */
function isRealDirectory(path) {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Remove one path that has already been proven to belong to this plugin.
 * @param {string} path absolute path.
 * @returns {true | 'failed'} true when gone (removed or already absent).
 */
function removeOwnedPath(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return true
  }
  try {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      unlinkSync(path)
      return true
    }
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return true
  } catch {
    return 'failed'
  }
}

/** Read a JSON object, or null for anything else (absent/corrupt/array). */
function readJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Atomic JSON write: temp file in the same directory, then rename. */
function writeJsonObject(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(temporary, JSON.stringify(value), 'utf8')
  renameSync(temporary, path)
}

/** Read the first bytes of a text file without loading the whole file. */
function readFilePrefix(path, byteCount) {
  let descriptor
  try {
    descriptor = openSync(path, 'r')
    const buffer = Buffer.alloc(byteCount)
    const read = readSync(descriptor, buffer, 0, byteCount, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        /* already closed */
      }
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Path encoding, ported from the official session-persistence-jsonl format:
 * projectKey() builds the readable cwd directory, encodeSegment() builds one
 * safe path segment. Safe ASCII is kept, separator runs collapse to one dash,
 * every other UTF-16 code unit is escaped as `~XXXX`.
 * ------------------------------------------------------------------------- */

/** @param {string} ch one UTF-16 code unit. */
function isSlugSafeChar(ch) {
  return /[A-Za-z0-9._-]/.test(ch)
}

/** @param {string} ch one UTF-16 code unit. */
function escapeSlugChar(ch) {
  return `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

/** Encode one id as the official single path segment (truncated to 251 chars). */
function encodeSegment(value) {
  const text = String(value)
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    out += isSlugSafeChar(ch) ? ch : escapeSlugChar(ch)
  }
  if (out.length === 0) out = 'root'
  return out.length > 251 ? out.slice(0, 251) : out
}

/** Turn an absolute cwd into the official readable session bucket name. */
function projectKey(cwd) {
  const text = String(cwd)
  let out = ''
  let separators = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separators) {
        out += '-'
        separators = true
      }
      continue
    }
    separators = false
    out += isSlugSafeChar(ch) ? ch : escapeSlugChar(ch)
  }
  out = out.replace(/^-+/, '')
  if (out.length === 0) out = 'root'
  if (out.length > 251) out = out.slice(0, 251)
  return `--${out}--`
}

/* ------------------------------------------------------------------------- *
 * Side-chat state: one directory per side chat, a marker inside it, and one
 * journal for cleanup obligations that still need the boot-time verification.
 * ------------------------------------------------------------------------- */

function sideDirectory(sideChatId) {
  return join(SIDE_ROOT, String(sideChatId))
}

/** The one workspace path a side chat can ever own. */
function workspaceOf(sideChatId) {
  return join(sideDirectory(sideChatId), 'workspace')
}

function markerPath(sideChatId) {
  return join(sideDirectory(sideChatId), 'marker.json')
}

/** Read one side chat's marker, validating that both ids are well-formed. */
function readMarker(sideChatId) {
  if (!isSafeId(sideChatId)) return null
  return readJsonObject(markerPath(sideChatId))
}

function writeMarker(sideChatId, marker) {
  writeJsonObject(markerPath(sideChatId), marker)
}

function readJournal() {
  const stored = readJsonObject(JOURNAL_PATH)
  const raw = stored === null ? null : stored.pending
  const pending = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return { version: 1, pending }
}

function writeJournal(journal) {
  writeJsonObject(JOURNAL_PATH, journal)
}

/**
 * Record a cleanup obligation BEFORE touching anything, so a crash can retry
 * it. Proof bookkeeping is persisted too: the log/cache that proved ownership
 * may already be deleted when a later boot retries, and the retry must still be
 * allowed to finish (and only then retire the entry).
 *
 * @param {string} sideChatId
 * @param {{ sessionId?: string|null, cwd?: string|null, proofKind?: 'live'|'cache'|'log'|null, provenSessionId?: string|null, candidateSessionId?: string|null, phase?: 'closing'|'verify', markerObserved?: boolean }} [state]
 */
function journalPending(sideChatId, state) {
  if (!isSafeId(sideChatId)) return
  const journal = readJournal()
  const previous = journal.pending[sideChatId] !== null && typeof journal.pending[sideChatId] === 'object'
    ? journal.pending[sideChatId]
    : {}
  const source = state === undefined ? {} : state
  const sessionId = isSafeId(source.sessionId) ? source.sessionId : isSafeId(previous.sessionId) ? previous.sessionId : null
  const cwd = typeof source.cwd === 'string' ? source.cwd : typeof previous.cwd === 'string' ? previous.cwd : null
  const proofKind = source.proofKind === 'live' || source.proofKind === 'cache' || source.proofKind === 'log'
    ? source.proofKind
    : previous.proofKind === 'live' || previous.proofKind === 'cache' || previous.proofKind === 'log'
      ? previous.proofKind
      : null
  const provenSessionId = isSafeId(source.provenSessionId)
    ? source.provenSessionId
    : isSafeId(previous.provenSessionId)
      ? previous.provenSessionId
      : null
  const candidateSessionId = source.candidateSessionId === null
    ? null
    : isSafeId(source.candidateSessionId)
      ? source.candidateSessionId
      : isSafeId(previous.candidateSessionId)
        ? previous.candidateSessionId
        : null
  journal.pending[sideChatId] = {
    sideChatId,
    sessionId,
    cwd,
    phase: source.phase === 'verify' ? 'verify' : 'closing',
    proofKind,
    provenSessionId,
    candidateSessionId,
    markerObserved: source.markerObserved === true || previous.markerObserved === true,
    updatedAt: new Date().toISOString(),
  }
  writeJournal(journal)
}

function clearJournalEntry(sideChatId) {
  const journal = readJournal()
  if (Object.prototype.hasOwnProperty.call(journal.pending, sideChatId)) {
    delete journal.pending[sideChatId]
    writeJournal(journal)
  }
}

/* ------------------------------------------------------------------------- *
 * Ownership proofs.
 * ------------------------------------------------------------------------- */

/** Collect the one session id a side chat can provably own. */
function ownedSessionId(marker) {
  if (marker === null || typeof marker !== 'object') return null
  return isSafeId(marker.sessionId) ? marker.sessionId : null
}

/**
 * The trusted working directory of a side chat. New side chats use their own
 * scratch workspace. Two update-compat shapes are accepted: a v0.2 fork marker
 * records the main conversation's cwd in `sourceCwd`, and a journal entry
 * written by this plugin's own Host half records a proven absolute cwd. A forged
 * marker cannot point the deletion bucket at an arbitrary directory because only
 * the canonical workspace or these plugin-written absolute paths are accepted.
 */
function trustedWorkspace(sideChatId, marker) {
  if (marker === null || typeof marker !== 'object') return null
  const expected = workspaceOf(sideChatId)
  if (typeof marker.cwd === 'string' && samePath(marker.cwd, expected)) return expected
  if (typeof marker.sourceCwd === 'string' && isAbsolute(marker.sourceCwd)) return resolve(marker.sourceCwd)
  const persistedProof = marker.proofKind === 'live' || marker.proofKind === 'cache' || marker.proofKind === 'log'
    || marker.proofKind === 'fork' || marker.proofKind === 'cache-fork'
  if (persistedProof && typeof marker.cwd === 'string' && isAbsolute(marker.cwd)) return resolve(marker.cwd)
  return null
}

/**
 * Read `record.identity.cwd` from a session's projection cache. The identity
 * block is at the head of the document, so a bounded prefix read is enough
 * (caches can be large); the fallback parses the whole file only when it is
 * small. `PROJCACHE_DIR` assumes the desktop profile's default storage-json
 * root — a custom root only produces a false negative (journal retained), never
 * a false positive deletion.
 */
function projectionCacheCwd(sessionId) {
  if (!isSafeId(sessionId)) return null
  const cachePath = join(PROJCACHE_DIR, `${sessionId}.json`)
  if (!inside(PROJCACHE_DIR, cachePath)) return null
  let text = readFilePrefix(cachePath, 64 * 1024)
  if (text === null) return null
  let identityIndex = text.indexOf('"identity"')
  if (identityIndex < 0) {
    // The prefix may have ended before the identity block only for unusually
    // large headers; retry with the whole file when it stays bounded.
    try {
      if (statSync(cachePath).size > 512 * 1024) return null
      text = readFileSync(cachePath, 'utf8')
    } catch {
      return null
    }
    identityIndex = text.indexOf('"identity"')
    if (identityIndex < 0) return null
  }
  const identityBlock = text.slice(identityIndex, identityIndex + 8 * 1024)
  const match = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(identityBlock)
  if (match === null) return null
  try {
    const cwd = JSON.parse(match[1])
    return typeof cwd === 'string' ? cwd : null
  } catch {
    return null
  }
}

/** Second ownership proof: the projection cache says this session ran in our workspace. */
function projectionCacheProvesOwnership(sessionId, expectedCwd) {
  if (!expectedCwd) return false
  const cwd = projectionCacheCwd(sessionId)
  return typeof cwd === 'string' && samePath(cwd, expectedCwd)
}

/**
 * Last-resort adoption for a crash between `sessions.create` and `bind`: the
 * side chat's workspace path is unique, so the projection cache that names it
 * identifies the session unambiguously. Only run for side chats that never
 * recorded a session id.
 */
function findSessionIdByCacheCwd(expectedCwd) {
  if (typeof expectedCwd !== 'string' || expectedCwd.length === 0) return null
  let entries
  try {
    entries = readdirSync(PROJCACHE_DIR)
  } catch {
    return null
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const sessionId = name.slice(0, -'.json'.length)
    if (!isSafeId(sessionId)) continue
    if (projectionCacheProvesOwnership(sessionId, expectedCwd)) return sessionId
  }
  return null
}

/**
 * Best-effort proof via the live host Session service: the session really was
 * created in the side chat's scratch directory. Never activates anything.
 * @returns {'ok' | 'mismatch' | 'unknown'}
 */
function verifySessionOwnership(scoped, sessionId, expectedCwd) {
  try {
    const sessions = scoped && typeof scoped.get === 'function' ? scoped.get('sessions') : undefined
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return 'unknown'
    const session = sessions.get(sessionId)
    if (session === undefined || session === null) return 'unknown'
    const cwd = session.header !== undefined && session.header !== null ? session.header.cwd : undefined
    if (typeof cwd !== 'string' || cwd.length === 0) return 'unknown'
    return samePath(cwd, expectedCwd) ? 'ok' : 'mismatch'
  } catch {
    return 'unknown'
  }
}

/* ------------------------------------------------------------------------- *
 * The exact artifact set a side chat owns.
 * ------------------------------------------------------------------------- */

/**
 * The event-log directory (bucket + encoded session segment) a side chat owns.
 * New side chats use their own scratch workspace bucket; v0.2 fork side chats
 * used the main project's bucket and their own child segment (retired on first
 * boot). Only the exact session segment is ever a deletion target.
 */
function ownedLogDirectory(sessionId, cwd) {
  if (!isSafeId(sessionId) || typeof cwd !== 'string' || cwd.length === 0) return null
  if (!isAbsolute(cwd)) return null
  const bucket = join(SESSIONS_ROOT, projectKey(cwd))
  if (!inside(SESSIONS_ROOT, bucket)) return null
  const directory = join(bucket, encodeSegment(sessionId))
  if (!inside(bucket, directory)) return null
  return { bucket, directory }
}

/** Whether the side chat's own session log directory exists right now. */
function hasOwnedSessionLog(sessionId, cwd) {
  const owned = ownedLogDirectory(sessionId, cwd)
  return owned !== null && isRealDirectory(owned.directory)
}

/** Delete the event-log directory of one quote-ask session (only its own bucket). */
function removeSessionLog(sessionId, cwd, removed, failed) {
  const owned = ownedLogDirectory(sessionId, cwd)
  if (owned === null) return
  const names = new Set([encodeSegment(sessionId), sessionId])
  for (const childName of names) {
    const target = join(owned.bucket, childName)
    if (!inside(SESSIONS_ROOT, target)) continue
    const outcome = removeOwnedPath(target)
    if (outcome === 'failed') failed.push(target)
    else if (lstatExists(target) === false) removed.push(target)
  }
  // Leave no empty per-cwd bucket behind when this was its only session.
  try {
    if (isRealDirectory(owned.bucket) && readdirSync(owned.bucket).length === 0) {
      rmdirSync(owned.bucket)
      removed.push(owned.bucket)
    }
  } catch {
    /* a non-empty or busy bucket is not an error */
  }
}

/** Whether a path exists (lstat semantics). */
function lstatExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Delete the projection-cache file for one quote-ask session. */
function removeProjectionCache(sessionId, removed, failed) {
  if (!isSafeId(sessionId)) return
  const target = join(PROJCACHE_DIR, `${sessionId}.json`)
  if (!inside(PROJCACHE_DIR, target)) return
  const existed = lstatExists(target)
  const outcome = removeOwnedPath(target)
  if (outcome === 'failed') failed.push(target)
  else if (existed) removed.push(target)
}

/** Delete spill directories belonging to one quote-ask session (all spill roots). */
function removeSpillDirectories(sessionId, removed, failed) {
  if (!isSafeId(sessionId)) return
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  const directoryName = `session-${hash}`
  let entries
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-spill-')) continue
    const target = join(tmpdir(), entry.name, directoryName)
    if (!inside(tmpdir(), target)) continue
    const existed = lstatExists(target)
    const outcome = removeOwnedPath(target)
    if (outcome === 'failed') failed.push(target)
    else if (existed) removed.push(target)
  }
}

/** Remove the quote-ask directory itself (scratch workspace + marker + journal). */
function removeSideChatDirectory(sideChatId, removed, failed) {
  if (!isSafeId(sideChatId)) return
  const target = sideDirectory(sideChatId)
  if (!inside(SIDE_ROOT, target)) return
  const outcome = removeOwnedPath(target)
  if (outcome === 'failed') failed.push(target)
  else removed.push(target)
}

/* ------------------------------------------------------------------------- *
 * Model-only quote-ask context.
 *
 * A side chat is an ordinary blank scratch session: no fork, so the UI shows no
 * inherited history. The main conversation and the quoted excerpt are rendered
 * into `<quote-ask>/context.md` and injected as a system-prompt section, which
 * is model-visible but never part of the visible transcript.
 * ------------------------------------------------------------------------- */

/** Host service lookup that never throws. */
function serviceOf(scoped, serviceName) {
  try {
    return scoped && typeof scoped.get === 'function' ? scoped.get(serviceName) : undefined
  } catch {
    return undefined
  }
}

/** Bound and clean one browser-supplied quote. */
function normalizeQuoteText(raw) {
  if (typeof raw !== 'string') return ''
  var text = raw.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()
  if (text.length > MAX_QUOTE_CHARS) text = text.slice(0, MAX_QUOTE_CHARS) + '\n…（引用过长，已截断）'
  return text
}

/** Sanitise the browser-captured exact-location facts of one quote. */
function normalizeQuoteAnchor(raw) {
  if (raw === null || typeof raw !== 'object') return null
  var anchor = {
    nodeKey: typeof raw.nodeKey === 'string' ? raw.nodeKey.slice(0, 300) : null,
    flowKey: typeof raw.flowKey === 'string' ? raw.flowKey.slice(0, 300) : null,
    flowKind: typeof raw.flowKind === 'string' ? raw.flowKind.slice(0, 80) : null,
    turn: Number.isSafeInteger(raw.turn) ? raw.turn : null,
    charStart: Number.isSafeInteger(raw.charStart) && raw.charStart >= 0 ? raw.charStart : null,
    charEnd: Number.isSafeInteger(raw.charEnd) && raw.charEnd >= 0 ? raw.charEnd : null,
    messageLength: Number.isSafeInteger(raw.messageLength) && raw.messageLength >= 0 ? raw.messageLength : null,
    before: typeof raw.before === 'string' ? raw.before.slice(0, 1200) : '',
    after: typeof raw.after === 'string' ? raw.after.slice(0, 1200) : '',
    messageText: typeof raw.messageText === 'string' ? raw.messageText.slice(0, 12000) : '',
  }
  if (anchor.nodeKey === null && anchor.charStart === null && anchor.messageText.length === 0) return null
  return anchor
}

/** One quote as stored in the marker and in context.md. */
function normalizeQuoteItem(item) {
  if (typeof item === 'string') {
    var textOnly = normalizeQuoteText(item)
    return textOnly.length === 0 ? null : { text: textOnly, anchor: null }
  }
  if (item === null || typeof item !== 'object') return null
  var text = normalizeQuoteText(item.text)
  if (text.length === 0) return null
  return { text, anchor: normalizeQuoteAnchor(item.anchor) }
}

/** Normalise a quote list, dropping duplicates (same text at the same spot). */
function normalizeQuoteList(raw) {
  if (!Array.isArray(raw)) return []
  var out = []
  for (const item of raw) {
    var quote = normalizeQuoteItem(item)
    if (quote === null) continue
    var duplicate = out.some((existing) => {
      if (existing.text !== quote.text) return false
      var left = existing.anchor
      var right = quote.anchor
      if (left === null || right === null) return left === right
      return left.nodeKey === right.nodeKey && left.charStart === right.charStart && left.charEnd === right.charEnd
    })
    if (!duplicate) out.push(quote)
    if (out.length >= MAX_QUOTES) break
  }
  return out
}

/** Joined text parts of one LLM message content array. */
function messageText(content) {
  if (!Array.isArray(content)) return ''
  var pieces = []
  for (var block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) pieces.push(block.text)
  }
  return pieces.join('\n').trim()
}

/** Render one main-conversation event as readable transcript text (or null). */
function renderMainEvent(event) {
  if (event === null || typeof event !== 'object') return null
  if (event.type === 'user/message') {
    var message = event.data
    if (message === null || typeof message !== 'object') return null
    // Plugin-injected runtime snapshots (time context, etc.) are not part of
    // the conversation the user wants carried over.
    if (message.source === null || typeof message.source !== 'object' || message.source.kind !== 'user') return null
    var text = messageText(message.content)
    return text.length === 0 ? null : '【用户】\n' + text
  }
  if (event.type === 'assistant/message') {
    var assistant = event.data !== null && typeof event.data === 'object' ? event.data.message : null
    if (assistant === null || typeof assistant !== 'object') return null
    var body = messageText(assistant.content)
    var tools = []
    if (Array.isArray(assistant.content)) {
      for (var call of assistant.content) {
        if (call !== null && typeof call === 'object' && call.type === 'tool-call' && typeof call.name === 'string') tools.push(call.name)
      }
    }
    if (body.length === 0 && tools.length === 0) return null
    return '【助手】\n'
      + (body.length === 0 ? '（只进行了工具调用）' : body)
      + (tools.length === 0 ? '' : '\n（调用工具：' + Array.from(new Set(tools)).join('、') + '）')
  }
  if (event.type === 'tool/result') {
    var toolMessage = event.data !== null && typeof event.data === 'object' ? event.data.message : null
    if (toolMessage === null || typeof toolMessage !== 'object') return null
    var resultText = messageText(toolMessage.content)
    if (resultText.length === 0) return null
    if (resultText.length > 1200) resultText = resultText.slice(0, 1200) + '\n…（工具结果过长，已截断）'
    return '【工具结果】\n' + resultText
  }
  return null
}

/**
 * Read a main conversation without activating it. The live Session is preferred
 * and the read-only session-query observation is the fallback. Never writes.
 * @returns {Promise<{ transcript: string, messageCount: number, truncated: boolean } | null>}
 */
async function readMainConversation(scoped, mainSessionId) {
  if (!isSafeId(mainSessionId)) return null
  var events = null
  var dispose = null
  var sessions = serviceOf(scoped, 'sessions')
  if (sessions !== undefined && sessions !== null && typeof sessions.get === 'function') {
    try {
      var live = sessions.get(mainSessionId)
      if (live !== undefined && live !== null && live.header !== null && typeof live.header === 'object' && typeof live.snapshotEvents === 'function') {
        events = live.snapshotEvents()
      }
    } catch {
      events = null
    }
  }
  if (!Array.isArray(events)) {
    var query = serviceOf(scoped, 'sessionQuery')
    if (query === undefined || query === null || typeof query.observeSession !== 'function') return null
    try {
      var observed = await query.observeSession(mainSessionId)
      events = observed !== null && typeof observed === 'object' ? observed.events : null
      dispose = observed
    } catch {
      return null
    }
  }
  try {
    if (!Array.isArray(events)) return null
    var blocks = []
    for (var event of events) {
      var rendered = renderMainEvent(event)
      if (rendered !== null) blocks.push(rendered)
    }
    var transcript = blocks.join('\n\n')
    var truncated = false
    if (transcript.length > MAX_CONTEXT_CHARS) {
      transcript = transcript.slice(transcript.length - MAX_CONTEXT_CHARS)
      var cut = transcript.indexOf('\n\n')
      if (cut >= 0) transcript = transcript.slice(cut + 2)
      truncated = true
    }
    return { transcript, messageCount: blocks.length, truncated }
  } finally {
    try {
      if (dispose !== null && typeof dispose === 'object') {
        if (typeof dispose[Symbol.dispose] === 'function') dispose[Symbol.dispose]()
        else if (typeof dispose.dispose === 'function') dispose.dispose()
      }
    } catch {
      /* observation disposal is best effort */
    }
  }
}

/** Build the hidden quote-ask context text for one opened side chat. */
/** Whitespace/markup-insensitive text used to align a deleted quote with its transcript copy. */
function normalizeMatchText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, '').replace(/[`*_>#~\[\]()]/g, '').toLowerCase()
}

/** Best transcript index for one deleted quote, using its captured surrounding text. */
function findRetiredQuoteOccurrence(out, item) {
  var text = item.text
  var anchor = item.anchor
  var first = out.indexOf(text)
  if (anchor === null) return first
  var before = normalizeMatchText(anchor.before).slice(-240)
  var after = normalizeMatchText(anchor.after).slice(0, 240)
  var best = -1
  var bestScore = -1
  var from = 0
  for (;;) {
    var index = out.indexOf(text, from)
    if (index < 0) break
    var pre = normalizeMatchText(out.slice(Math.max(0, index - 360), index))
    var post = normalizeMatchText(out.slice(index + text.length, index + text.length + 360))
    var score = 0
    for (var n = Math.min(pre.length, before.length); n > 0; n -= 1) {
      if (pre.slice(-n) === before.slice(-n)) {
        score += n
        break
      }
    }
    for (var m = Math.min(post.length, after.length); m > 0; m -= 1) {
      if (post.slice(0, m) === after.slice(0, m)) {
        score += m
        break
      }
    }
    if (score > bestScore) {
      bestScore = score
      best = index
    }
    from = index + text.length
  }
  // Anchored quotes need some surrounding agreement; otherwise leave the
  // transcript copy alone instead of redacting an unrelated occurrence.
  return bestScore >= 10 ? best : -1
}

/**
 * Remove the exact occurrence(s) of deleted quotes from the main-conversation
 * transcript, so removing a quote really removes its content from the model
 * context instead of only hiding a line in the browser.
 */
function redactRetiredQuotes(transcript, retiredQuotes) {
  if (typeof transcript !== 'string' || transcript.length === 0) return transcript
  if (!Array.isArray(retiredQuotes) || retiredQuotes.length === 0) return transcript
  var out = transcript
  for (const raw of retiredQuotes) {
    var item = normalizeQuoteItem(raw)
    if (item === null || item.text.length < 4) continue
    var index = findRetiredQuoteOccurrence(out, item)
    if (index < 0) continue
    out = out.slice(0, index) + '〔该引用片段已删除〕' + out.slice(index + item.text.length)
  }
  return out
}

function buildSideChatContextText(mainSessionId, quotes, conversation, retiredQuotes) {
  var effectiveQuotes = normalizeQuoteList(quotes)
  var transcript = conversation !== null && typeof conversation === 'object' && typeof conversation.transcript === 'string'
    ? conversation.transcript
    : ''
  transcript = redactRetiredQuotes(transcript, retiredQuotes)
  var truncated = conversation !== null && typeof conversation === 'object' && conversation.truncated === true
  var lines = [
    '# 侧边聊天（针对引用片段的独立问答）',
    '',
    '你正在 DSH 的「侧边聊天」中回答用户的问题。侧边聊天不是主对话的继续，而是用户从主对话中选中片段后，针对该片段提出的独立问题。',
    '',
    '## 回答规则（按优先级）',
    '1. **必须优先回答引用片段本身**：用户的问题就是关于下面「用户引用自主对话的片段」的。回答的第一部分要直接针对引用内容（它是什么、为什么、含义、用法等），不能答非所问。',
    '2. 用户问题里的「这个 / 它 / 上面 / 这段」等指代，一律指用户引用的片段。',
    '3. 下面还给出了每条引用的**精确位置**（所在消息、轮次、字符偏移和前后文）。请以这些精确位置为准，不要猜测「大概来自某处」，也不需要让用户再补充上下文。',
    '4. 主对话历史只是背景资料：用它来补充、解释引用片段，不要接着主对话最后一条继续写，也不要假设用户想换个地方继续原来的对话。',
    '5. **忽略与本引用无关的运行时通知、权限变更、系统提示**，不要拿它们当作用户的问题。',
    '6. 用户可能引用了多个片段，请分别针对每一条回答。',
    '7. 资料不足时明确说明缺少什么；用中文回答。',
    '',
  ]
  if (effectiveQuotes.length > 0) {
    lines.push('## 用户引用自主对话的片段（共 ' + effectiveQuotes.length + ' 条）', '')
    for (var index = 0; index < effectiveQuotes.length; index += 1) {
      lines.push('### 引用 ' + (index + 1), '', '> ' + effectiveQuotes[index].text.replace(/\n/g, '\n> '), '')
    }
  } else {
    lines.push('## 用户引用自主对话的片段', '', '（本次没有引用片段，请根据用户问题并结合主对话历史回答。）', '')
  }
  lines.push('## 主对话历史（背景资料，不显示给用户）', '')
  if (transcript.length === 0) {
    lines.push('（没有读取到可用的主对话文本。）')
  } else {
    if (truncated) lines.push('（主对话历史过长，以下只保留最近的部分。）', '')
    lines.push(transcript)
  }
  if (effectiveQuotes.length > 0) {
    lines.push('', '## 引用片段的精确位置（模型据此锁定原文）', '')
    for (var preciseIndex = 0; preciseIndex < effectiveQuotes.length; preciseIndex += 1) {
      var preciseQuote = effectiveQuotes[preciseIndex]
      lines.push('### 引用 ' + (preciseIndex + 1) + ' 的精确位置')
      lines.push('', '选中文字：', '> ' + preciseQuote.text.replace(/\n/g, '\n> '), '')
      if (preciseQuote.anchor === null) {
        lines.push('（客户端没有捕获到 DOM 位置；请依据引用文字与主对话上下文回答，不要要求用户重复提供同一段上下文。）', '')
        continue
      }
      var anchor = preciseQuote.anchor
      if (anchor.flowKind !== null || anchor.turn !== null) {
        lines.push('- 所在消息类型：' + (anchor.flowKind === null ? '未知' : anchor.flowKind) + (anchor.turn === null ? '' : '；所在轮次：第 ' + anchor.turn + ' 轮'))
      }
      if (anchor.nodeKey !== null || anchor.flowKey !== null) {
        lines.push('- 消息标识：' + (anchor.nodeKey !== null ? anchor.nodeKey : anchor.flowKey))
      }
      if (anchor.charStart !== null && anchor.charEnd !== null) {
        lines.push('- 在该消息渲染文本中的字符偏移：' + anchor.charStart + '–' + anchor.charEnd
          + (anchor.messageLength === null ? '' : '（该消息共 ' + anchor.messageLength + ' 字）'))
      }
      if (anchor.before.length > 0 || anchor.after.length > 0) {
        lines.push('', '- 选中处前后文（【】内为选中文字）：', '', '```text', anchor.before + '【' + preciseQuote.text + '】' + anchor.after, '```')
      }
      if (anchor.messageText.length > 0) {
        lines.push('', '- 该消息完整文本：', '', '```text', anchor.messageText, '```')
      }
      lines.push('')
    }
    lines.push('## 再次强调：本次必须回答的引用片段', '')
    for (var repeatIndex = 0; repeatIndex < effectiveQuotes.length; repeatIndex += 1) {
      lines.push('> ' + effectiveQuotes[repeatIndex].text.replace(/\n/g, '\n> '), '')
    }
    lines.push('用户的问题是关于上面引用片段的，请先直接回答引用内容，再结合主对话历史补充；引用位置以上面的「精确位置」为准，不要猜测。')
  }
  lines.push('', '---', '以上上下文由 dsh-quote-ask 自动生成，仅用于本次侧边聊天；关闭侧边聊天后会被删除。')
  return lines.join('\n')
}

/**
 * System-prompt section text for one quote-ask session. Ordinary sessions get
 * an empty string (dropped by the prompt renderer), so the main conversation
 * prompt is byte-identical to before this plugin.
 */
function sideChatPromptContext(context) {
  try {
    var agent = context !== null && typeof context === 'object' && context.agent !== null && typeof context.agent === 'object'
      ? context.agent
      : null
    var session = agent !== null && agent.session !== null && typeof agent.session === 'object' ? agent.session : null
    var cwd = session !== null && session.header !== null && typeof session.header === 'object' ? session.header.cwd : null
    if (typeof cwd !== 'string' || cwd.length === 0) return ''
    var sideDir = dirname(cwd)
    if (!inside(SIDE_ROOT, sideDir)) return ''
    var file = join(sideDir, CONTEXT_FILE)
    if (!inside(SIDE_ROOT, file)) return ''
    var stat = statSync(file)
    if (!stat.isFile() || stat.size > MAX_CONTEXT_FILE_BYTES) return ''
    var text = readFileSync(file, 'utf8')
    return text.trim().length > 0 ? text : ''
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------------- *
 * Public state operations.
 * ------------------------------------------------------------------------- */

/**
 * Create the scratch directory and marker for one side chat, and write the
 * model-only context file that the system-prompt section injects.
 * @param {string} sideChatId client-minted uuid.
 * @param {string | null} mainSessionId conversation the side chat was opened from.
 * @param {string} contextText rendered main-conversation context (never shown in the UI).
 * @param {string[]} quotes selected excerpts that produced the context text.
 */
function prepareSideChat(sideChatId, mainSessionId, contextText, quotes) {
  if (!isSafeId(sideChatId)) throw new Error('invalid sideChatId')
  if (mainSessionId !== null && mainSessionId !== undefined && !isSafeId(mainSessionId)) {
    throw new Error('invalid mainSessionId')
  }
  if (typeof contextText !== 'string' || contextText.length === 0) throw new Error('empty quote-ask context')
  if (readMarker(sideChatId) !== null) throw new Error('side chat already exists')
  const effectiveQuotes = normalizeQuoteList(quotes)
  const workspace = workspaceOf(sideChatId)
  mkdirSync(workspace, { recursive: true })
  const marker = {
    version: 4,
    sideChatId,
    mainSessionId: isSafeId(mainSessionId) ? mainSessionId : null,
    sessionId: null,
    cwd: workspace,
    quotes: effectiveQuotes,
    retiredQuotes: [],
    status: 'prepared',
    ownershipVerified: false,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  writeMarker(sideChatId, marker)
  writeFileSync(join(sideDirectory(sideChatId), CONTEXT_FILE), contextText, 'utf8')
  return marker
}

/**
 * Bind the created session to its side chat and mark it open. Before recording
 * the identity, check (when the live session service can answer) that the
 * session's cwd really is this side chat's own workspace; a projection-cache
 * cwd match is accepted as the fallback proof.
 */
function bindSideChat(sideChatId, sessionId, scoped) {
  if (!isSafeId(sideChatId)) throw new Error('invalid sideChatId')
  if (!isSafeId(sessionId)) throw new Error('invalid sessionId')
  const marker = readMarker(sideChatId)
  if (marker === null) throw new Error('unknown side chat')
  const expectedCwd = trustedWorkspace(sideChatId, marker)
  if (expectedCwd === null) throw new Error('side chat workspace is inconsistent')
  if (marker.status === 'open' && marker.sessionId === sessionId) return marker
  if (marker.status !== 'prepared') throw new Error('side chat is not bindable')
  const ownership = verifySessionOwnership(scoped, sessionId, expectedCwd)
  if (ownership === 'mismatch') throw new Error('session cwd does not belong to this side chat')
  const proven = ownership === 'ok' || projectionCacheProvesOwnership(sessionId, expectedCwd)
  marker.sessionId = sessionId
  marker.status = 'open'
  marker.ownershipVerified = proven
  marker.lastSeenAt = new Date().toISOString()
  marker.updatedAt = new Date().toISOString()
  writeMarker(sideChatId, marker)
  return marker
}

/**
 * Append one selected excerpt to an open side chat and regenerate its
 * model-only context file. Repeating the exact same excerpt is a no-op.
 * @param {string} sideChatId
 * @param {string} rawQuote
 * @param {{ get?: (name: string) => any } | undefined} scoped
 * @param {readonly string[] | undefined} providedQuotes full quote list from the
 *   client, used so a v0.3 side chat (whose marker has no quotes) keeps its
 *   original quote when a new one is appended.
 * @returns {Promise<number>} the number of quotes now stored.
 */
async function appendSideChatQuote(sideChatId, rawQuote, rawAnchor, scoped, providedQuotes) {
  if (!isSafeId(sideChatId)) throw new Error('invalid sideChatId')
  const quote = normalizeQuoteText(rawQuote)
  if (quote.length === 0) throw new Error('empty quote')
  const quoteItem = { text: quote, anchor: normalizeQuoteAnchor(rawAnchor) }
  const marker = readMarker(sideChatId)
  if (marker === null) throw new Error('unknown side chat')
  if (marker.status !== 'open') throw new Error('side chat is not open')
  let quotes
  if (Array.isArray(providedQuotes)) {
    quotes = normalizeQuoteList(providedQuotes)
    const alreadyQuoted = quotes.some((existing) => sameQuoteItem(existing, quoteItem))
    if (!alreadyQuoted) quotes.push(quoteItem)
  } else {
    quotes = normalizeQuoteList(marker.quotes)
    if (quotes.some((existing) => sameQuoteItem(existing, quoteItem))) return quotes.length
    quotes.push(quoteItem)
  }
  if (quotes.length > MAX_QUOTES) throw new Error('引用片段数量已达上限')
  // A re-added quote must stop being redacted from the main transcript.
  const retiredQuotes = normalizeQuoteList(marker.retiredQuotes).filter((existing) => !sameQuoteItem(existing, quoteItem))
  const mainSessionId = isSafeId(marker.mainSessionId) ? marker.mainSessionId : null
  const conversation = mainSessionId === null ? null : await readMainConversation(scoped, mainSessionId)
  const contextText = buildSideChatContextText(mainSessionId, quotes, conversation, retiredQuotes)
  writeFileSync(join(sideDirectory(sideChatId), CONTEXT_FILE), contextText, 'utf8')
  marker.quotes = quotes
  marker.retiredQuotes = retiredQuotes
  marker.updatedAt = new Date().toISOString()
  writeMarker(sideChatId, marker)
  return quotes.length
}

/**
 * Remove one quote from a side chat and regenerate the model-only context file.
 * The next turn therefore no longer sees the removed excerpt at all; this is not
 * a UI-only change.
 */
async function removeSideChatQuote(sideChatId, rawQuote, rawAnchor, scoped) {
  if (!isSafeId(sideChatId)) throw new Error('invalid sideChatId')
  const quote = normalizeQuoteText(rawQuote)
  if (quote.length === 0) throw new Error('empty quote')
  const quoteItem = { text: quote, anchor: normalizeQuoteAnchor(rawAnchor) }
  const marker = readMarker(sideChatId)
  if (marker === null) throw new Error('unknown side chat')
  if (marker.status !== 'open') throw new Error('side chat is not open')
  const quotes = normalizeQuoteList(marker.quotes)
  const index = quotes.findIndex((existing) => sameQuoteItem(existing, quoteItem))
  if (index < 0) throw new Error('找不到该引用片段')
  quotes.splice(index, 1)
  const retiredQuotes = normalizeQuoteList(marker.retiredQuotes)
  if (!retiredQuotes.some((existing) => sameQuoteItem(existing, quoteItem))) retiredQuotes.push(quoteItem)
  if (retiredQuotes.length > MAX_QUOTES) retiredQuotes.splice(0, retiredQuotes.length - MAX_QUOTES)
  const mainSessionId = isSafeId(marker.mainSessionId) ? marker.mainSessionId : null
  const conversation = mainSessionId === null ? null : await readMainConversation(scoped, mainSessionId)
  const contextText = buildSideChatContextText(mainSessionId, quotes, conversation, retiredQuotes)
  writeFileSync(join(sideDirectory(sideChatId), CONTEXT_FILE), contextText, 'utf8')
  marker.quotes = quotes
  marker.retiredQuotes = retiredQuotes
  marker.updatedAt = new Date().toISOString()
  writeMarker(sideChatId, marker)
  return quotes.length
}

/** Whether two quote items mean the same text selected at the same spot. */
function sameQuoteItem(left, right) {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (left.text !== right.text) return false
  var leftAnchor = left.anchor
  var rightAnchor = right.anchor
  if (leftAnchor === null || leftAnchor === undefined || rightAnchor === null || rightAnchor === undefined) {
    return leftAnchor === rightAnchor
  }
  return leftAnchor.nodeKey === rightAnchor.nodeKey
    && leftAnchor.charStart === rightAnchor.charStart
    && leftAnchor.charEnd === rightAnchor.charEnd
}

/* ------------------------------------------------------------------------- *
 * "添加至对话": quotes attached to the next turn of the MAIN conversation.
 *
 * These are different from side chats: there is no new session. The Host keeps
 * a per-main-session state file and injects the attached quotes through the
 * normal system-prompt section for exactly one turn. A page reload keeps them;
 * a DSH restart clears them.
 * ------------------------------------------------------------------------- */

function mainQuotesPath(sessionId) {
  if (!isSafeId(sessionId)) return null
  return join(MAIN_QUOTES_DIR, `${sessionId}.json`)
}

function emptyMainQuoteState() {
  return { active: [], pending: [], turnActive: false }
}

function readMainQuoteState(sessionId) {
  const path = mainQuotesPath(sessionId)
  if (path === null) return emptyMainQuoteState()
  const raw = readJsonObject(path)
  if (raw === null || typeof raw !== 'object') return emptyMainQuoteState()
  return {
    active: normalizeQuoteList(raw.active),
    pending: normalizeQuoteList(raw.pending),
    turnActive: raw.turnActive === true,
  }
}

function writeMainQuoteState(sessionId, state) {
  const path = mainQuotesPath(sessionId)
  if (path === null) return
  const active = normalizeQuoteList(state.active)
  const pending = normalizeQuoteList(state.pending)
  if (active.length === 0 && pending.length === 0) {
    try {
      unlinkSync(path)
    } catch {
      /* already gone */
    }
    return
  }
  writeJsonObject(path, {
    version: 1,
    active,
    pending,
    turnActive: state.turnActive === true,
    updatedAt: new Date().toISOString(),
  })
}

/** All currently attached quotes, active turn quotes first. */
function listMainQuotes(sessionId) {
  const state = readMainQuoteState(sessionId)
  return state.active.concat(state.pending)
}

function attachMainQuote(mainSessionId, rawQuote, rawAnchor) {
  if (!isSafeId(mainSessionId)) throw new Error('invalid mainSessionId')
  const quote = normalizeQuoteText(rawQuote)
  if (quote.length === 0) throw new Error('empty quote')
  const quoteItem = { text: quote, anchor: normalizeQuoteAnchor(rawAnchor) }
  const state = readMainQuoteState(mainSessionId)
  const all = listMainQuotes(mainSessionId)
  if (all.some((existing) => sameQuoteItem(existing, quoteItem))) return all.length
  if (all.length >= MAX_MAIN_QUOTES) throw new Error('附加引用数量已达上限')
  state.pending.push(quoteItem)
  writeMainQuoteState(mainSessionId, state)
  return all.length + 1
}

function removeMainQuote(mainSessionId, rawQuote, rawAnchor) {
  if (!isSafeId(mainSessionId)) throw new Error('invalid mainSessionId')
  const quote = normalizeQuoteText(rawQuote)
  if (quote.length === 0) throw new Error('empty quote')
  const quoteItem = { text: quote, anchor: normalizeQuoteAnchor(rawAnchor) }
  const state = readMainQuoteState(mainSessionId)
  const active = state.active.filter((existing) => !sameQuoteItem(existing, quoteItem))
  const pending = state.pending.filter((existing) => !sameQuoteItem(existing, quoteItem))
  if (active.length === state.active.length && pending.length === state.pending.length) {
    throw new Error('找不到该引用片段')
  }
  state.active = active
  state.pending = pending
  writeMainQuoteState(mainSessionId, state)
  return active.length + pending.length
}

function buildMainQuoteContextText(mainSessionId, quotes) {
  const effectiveQuotes = normalizeQuoteList(quotes)
  if (effectiveQuotes.length === 0) return ''
  const lines = [
    '# 用户在主对话中附加的引用片段',
    '',
    '用户接下来发送的问题，是围绕这些引用片段提出的。请优先、准确地回答引用本身，再结合主对话历史补充；不要接着上一条回答继续写。',
    '',
    '## 引用片段（共 ' + effectiveQuotes.length + ' 条）',
    '',
  ]
  for (let index = 0; index < effectiveQuotes.length; index += 1) {
    const quote = effectiveQuotes[index]
    lines.push('### 引用 ' + (index + 1), '', '> ' + quote.text.replace(/\n/g, '\n> '), '')
    if (quote.anchor !== null) {
      const anchor = quote.anchor
      if (anchor.flowKind !== null || anchor.turn !== null) {
        lines.push('- 所在消息类型：' + (anchor.flowKind === null ? '未知' : anchor.flowKind)
          + (anchor.turn === null ? '' : '；所在轮次：第 ' + anchor.turn + ' 轮'))
      }
      if (anchor.nodeKey !== null || anchor.flowKey !== null) {
        lines.push('- 消息标识：' + (anchor.nodeKey !== null ? anchor.nodeKey : anchor.flowKey))
      }
      if (anchor.charStart !== null && anchor.charEnd !== null) {
        lines.push('- 在该消息渲染文本中的字符偏移：' + anchor.charStart + '–' + anchor.charEnd
          + (anchor.messageLength === null ? '' : '（该消息共 ' + anchor.messageLength + ' 字）'))
      }
      if (anchor.before.length > 0 || anchor.after.length > 0) {
        lines.push('', '- 选中处前后文（【】内为选中文字）：', '', '```text', anchor.before + '【' + quote.text + '】' + anchor.after, '```')
      }
      if (anchor.messageText.length > 0) {
        lines.push('', '- 该消息完整文本：', '', '```text', anchor.messageText, '```')
      }
      lines.push('')
    }
  }
  lines.push('---', '以上引用由 dsh-quote-ask 的「添加至对话」功能附加，仅用于本次提问；回答后会自动清除。')
  return lines.join('\n')
}

/** Hidden system-prompt section for attached main-conversation quotes. */
function mainQuotePromptContext(context) {
  try {
    const agent = context !== null && typeof context === 'object' && context.agent !== null && typeof context.agent === 'object'
      ? context.agent
      : null
    const session = agent !== null && agent.session !== null && typeof agent.session === 'object' ? agent.session : null
    const header = session !== null && session.header !== null && typeof session.header === 'object' ? session.header : null
    if (header === null || !isSafeId(header.id)) return ''
    // Side-chat sessions have their own context section.
    if (typeof header.cwd === 'string' && header.cwd.length > 0 && inside(SIDE_ROOT, dirname(header.cwd))) return ''
    const path = mainQuotesPath(header.id)
    if (path === null || !lstatExists(path)) return ''
    const state = readMainQuoteState(header.id)
    const chosen = state.active.length > 0 ? state.active : state.turnActive ? [] : state.pending
    if (chosen.length === 0) return ''
    return buildMainQuoteContextText(header.id, chosen)
  } catch {
    return ''
  }
}

/** One system-prompt section shared by side chats and main-conversation quotes. */
function promptSectionText(context) {
  const side = sideChatPromptContext(context)
  if (side.length > 0) return side
  return mainQuotePromptContext(context)
}

/** Move pending quotes into the active turn when the next prompt starts, and clear them at turn end. */
function handleMainQuoteTurnEvent(session, event) {
  try {
    if (session === null || typeof session !== 'object' || !isSafeId(session.id)) return
    if (event === null || typeof event !== 'object' || (event.type !== 'turn/start' && event.type !== 'turn/end')) return
    const path = mainQuotesPath(session.id)
    if (path === null || !lstatExists(path)) return
    const state = readMainQuoteState(session.id)
    if (event.type === 'turn/start') {
      if (state.pending.length > 0) state.active = state.active.concat(state.pending)
      state.pending = []
      state.turnActive = true
    } else {
      state.active = []
      state.turnActive = false
    }
    writeMainQuoteState(session.id, state)
  } catch {
    /* never break a session event */
  }
}

/** Agent idle fallback for the turn/end clear (covers event-shape changes). */
function handleMainQuoteAgentStatus(agent, status) {
  try {
    if (status !== false || agent === null || typeof agent !== 'object') return
    const session = agent.session
    if (session === null || typeof session !== 'object' || !isSafeId(session.id)) return
    const path = mainQuotesPath(session.id)
    if (path === null || !lstatExists(path)) return
    const state = readMainQuoteState(session.id)
    if (state.active.length === 0 && state.turnActive !== true) return
    state.active = []
    state.turnActive = false
    writeMainQuoteState(session.id, state)
  } catch {
    /* never break an agent status event */
  }
}

/** Begin the next main-conversation turn: pending attachments become active. */
function beginMainQuoteTurn(mainSessionId) {
  const state = readMainQuoteState(mainSessionId)
  if (state.pending.length > 0) state.active = state.active.concat(state.pending)
  state.pending = []
  state.turnActive = true
  writeMainQuoteState(mainSessionId, state)
  return state.active.length + state.pending.length
}

/** End a main-conversation turn: active attachments are consumed. */
function endMainQuoteTurn(mainSessionId) {
  const state = readMainQuoteState(mainSessionId)
  state.active = []
  state.turnActive = false
  writeMainQuoteState(mainSessionId, state)
  return state.pending.length
}

/**
 * Route-side fallback: if a live session's last durable event is turn/end, an
 * active attachment has already been consumed. This keeps the chip honest even
 * if a session-event shape changes between DSH versions.
 */
function settleMainQuoteTurn(mainSessionId, scoped) {
  try {
    const state = readMainQuoteState(mainSessionId)
    if (state.turnActive !== true || state.active.length === 0) return
    const sessions = serviceOf(scoped, 'sessions')
    const live = sessions !== undefined && sessions !== null && typeof sessions.get === 'function' ? sessions.get(mainSessionId) : undefined
    const events = live !== undefined && live !== null && typeof live.snapshotEvents === 'function' ? live.snapshotEvents() : []
    const last = events.length > 0 ? events[events.length - 1] : null
    if (last !== null && last.type === 'turn/end') {
      state.active = []
      state.turnActive = false
      writeMainQuoteState(mainSessionId, state)
    }
  } catch {
    /* fallback only */
  }
}

function clearAllMainQuotes() {
  try {
    rmSync(MAIN_QUOTES_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/** Refresh an open side chat's activity timestamp (called when its tab mounts). */
function touchSideChat(sideChatId) {
  if (!isSafeId(sideChatId)) return false
  const marker = readMarker(sideChatId)
  if (marker === null || marker.status !== 'open') return false
  marker.lastSeenAt = new Date().toISOString()
  marker.updatedAt = marker.lastSeenAt
  // A live tab cancels any pending idle-reap notice.
  delete marker.idleNoticeAt
  writeMarker(sideChatId, marker)
  return true
}

/** Find a side chat by id, falling back to a scan keyed by session id. */
function resolveSideChat(sideChatId, sessionId) {
  if (isSafeId(sideChatId)) return { sideChatId, marker: readMarker(sideChatId) }
  if (isSafeId(sessionId)) {
    try {
      for (const entry of readdirSync(SIDE_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory() || !isSafeId(entry.name)) continue
        const marker = readMarker(entry.name)
        if (marker !== null && marker.sessionId === sessionId) return { sideChatId: entry.name, marker }
      }
    } catch {
      /* no side root: nothing to resolve */
    }
  }
  return null
}

/**
 * A directory without a marker is only ever reaped when its name, contents and
 * age all say "interrupted side chat": one of the two id shapes this plugin
 * mints, a `workspace/` child, and 24h of age. The startup sweep applies the
 * same gate, so a journal entry cannot bypass it.
 */
function markerlessDirectoryGuard(sideChatId) {
  if (!isSafeId(sideChatId)) return false
  const claimed = UUID_SHAPE.test(sideChatId) || /^sc-/.test(sideChatId)
  if (!claimed || !isRealDirectory(workspaceOf(sideChatId))) return false
  try {
    return Date.now() - statSync(sideDirectory(sideChatId)).mtimeMs > MARKERLESS_AGE_MS
  } catch {
    return false
  }
}

/**
 * Delete every artifact of one side chat. Idempotent and safe to call for a
 * half-created side chat (prepare succeeded but bind never did).
 *
 * Close-time calls keep a journal entry in the `verify` phase: the session may
 * still be alive, and its disposal can rewrite the projection cache after our
 * delete. A later boot-time sweep re-runs the cleanup and only then retires the
 * journal entry.
 *
 * @param {{ sideChatId?: string, sessionId?: string }} request
 * @param {{ scoped?: any, finalize?: boolean, allowMarkerless?: boolean }} [options]
 * @returns {{ sideChatId: string | null, sessionId: string | null, removed: string[], failed: string[] }}
 */
function cleanupSideChat(request, options) {
  const settings = options === undefined ? {} : options
  const result = { sideChatId: null, sessionId: null, removed: [], failed: [] }
  const safeRequest = request === undefined ? {} : request
  const resolved = resolveSideChat(safeRequest.sideChatId, safeRequest.sessionId)
  if (resolved === null) return result
  const sideChatId = resolved.sideChatId
  result.sideChatId = sideChatId

  const journal = readJournal()
  const pending = journal.pending[sideChatId] !== null && typeof journal.pending[sideChatId] === 'object'
    ? journal.pending[sideChatId]
    : null
  let marker = resolved.marker
  const sideDirectoryPresent = lstatExists(sideDirectory(sideChatId))
  const markerObserved = marker !== null || (pending !== null && pending.markerObserved === true)
  const workspace = trustedWorkspace(sideChatId, marker) ?? trustedWorkspace(sideChatId, pending)

  let sessionId = ownedSessionId(marker) ?? ownedSessionId(pending)
  // `fork`/`cache-fork` are the v0.2 journal vocabulary; a proof persisted by the
  // previous version still authorizes finishing that side chat's cleanup.
  const FORK_PROOF = { live: true, cache: true, log: true, fork: true, 'cache-fork': true }
  let liveProven = (marker !== null && marker.ownershipVerified === true)
    || (pending !== null && typeof pending.proofKind === 'string' && FORK_PROOF[pending.proofKind] === true && pending.provenSessionId === ownedSessionId(pending))
  let candidateSessionId = isSafeId(safeRequest.sessionId)
    ? safeRequest.sessionId
    : pending !== null && isSafeId(pending.candidateSessionId)
      ? pending.candidateSessionId
      : null

  // A bind that failed after the session was created still has to be cleanable:
  // accept the request/journal candidate only when an ownership proof agrees.
  if (sessionId === null && workspace !== null && candidateSessionId !== null) {
    const verdict = verifySessionOwnership(settings.scoped, candidateSessionId, workspace)
    if (verdict === 'ok' || projectionCacheProvesOwnership(candidateSessionId, workspace)) {
      sessionId = candidateSessionId
      candidateSessionId = null
      liveProven = verdict === 'ok'
      if (marker !== null) {
        marker.sessionId = sessionId
        marker.ownershipVerified = liveProven
        marker.updatedAt = new Date().toISOString()
        try {
          writeMarker(sideChatId, marker)
        } catch {
          /* the journal below still records the obligation */
        }
      }
    }
  }
  // Last resort for a crash between `sessions.create` and `bind`: the workspace
  // path is unique, so a projection cache naming it identifies the session.
  if (sessionId === null && workspace !== null) {
    sessionId = findSessionIdByCacheCwd(workspace)
  }

  const cacheProven = sessionId !== null && workspace !== null && projectionCacheProvesOwnership(sessionId, workspace)
  const logProven = sessionId !== null && workspace !== null && hasOwnedSessionLog(sessionId, workspace)
  // A proof persisted by an earlier pass (whose log/cache it already deleted)
  // still authorizes finishing the same session's artifacts.
  const persistedProven = sessionId !== null && pending !== null
    && typeof pending.proofKind === 'string'
    && FORK_PROOF[pending.proofKind] === true
    && pending.provenSessionId === sessionId
  const ownershipProven = liveProven || cacheProven || logProven || persistedProven
  const proofKind = liveProven ? 'live' : logProven ? 'log' : cacheProven ? 'cache' : null
  const shouldJournal = markerObserved || pending !== null || settings.allowMarkerless === true
  const journalState = {
    sessionId,
    cwd: workspace,
    proofKind,
    provenSessionId: proofKind === null ? undefined : sessionId,
    candidateSessionId,
    phase: settings.finalize === true ? 'verify' : 'closing',
    markerObserved,
  }
  if (shouldJournal || sessionId !== null) journalPending(sideChatId, journalState)

  if (sessionId !== null) {
    result.sessionId = sessionId
    if (ownershipProven) {
      removeProjectionCache(sessionId, result.removed, result.failed)
      removeSpillDirectories(sessionId, result.removed, result.failed)
      removeSessionLog(sessionId, workspace, result.removed, result.failed)
    } else {
      // Never silently drop an unproven session: keep the journal entry so a
      // later pass can prove it when the cache has been flushed.
      result.failed.push(`unproven-session:${sessionId}`)
    }
  }

  let canRemoveSideDirectory = false
  if (markerObserved) canRemoveSideDirectory = true
  else if (!sideDirectoryPresent) canRemoveSideDirectory = true
  else if (settings.allowMarkerless === true || pending !== null) canRemoveSideDirectory = markerlessDirectoryGuard(sideChatId)
  if (canRemoveSideDirectory) removeSideChatDirectory(sideChatId, result.removed, result.failed)
  else result.failed.push(`unproven-side-directory:${sideChatId}`)

  if (result.failed.length === 0) {
    if (settings.finalize === true || !shouldJournal) {
      clearJournalEntry(sideChatId)
    } else if (sessionId === null && candidateSessionId === null) {
      // Nothing durable can come back when no session was ever recorded.
      clearJournalEntry(sideChatId)
    } else {
      // Keep the obligation for one boot-time verification pass.
      journalPending(sideChatId, { ...journalState, phase: 'verify' })
    }
  } else {
    journalPending(sideChatId, { ...journalState, phase: 'closing' })
  }
  return result
}

/**
 * Startup sweep: finalize journaled cleanups, finish side chats that crashed
 * between prepare and bind, and delete every side chat left open by a previous
 * DSH run. Side chats are session-scoped: quitting DSH ends them, and the next
 * boot must not leave their sessions in the conversation list.
 */
function sweepSideChats(ctx, options) {
  const settings = options === undefined ? {} : options
  const bootAt = Number.isFinite(settings.bootAt) ? settings.bootAt : 0
  try {
    const journal = readJournal()
    for (const sideChatId of Object.keys(journal.pending)) {
      if (!isSafeId(sideChatId)) {
        clearJournalEntry(sideChatId)
        continue
      }
      try {
        const outcome = cleanupSideChat({ sideChatId }, { finalize: true })
        if (outcome.failed.length > 0) warn(ctx, `startup cleanup incomplete for ${sideChatId}: ${outcome.failed.join(', ')}`)
      } catch (error) {
        warn(ctx, `startup cleanup failed for ${sideChatId}: ${messageOf(error)}`)
      }
    }
  } catch (error) {
    warn(ctx, `journal sweep failed: ${messageOf(error)}`)
  }

  let entries
  try {
    entries = readdirSync(SIDE_ROOT, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeId(entry.name)) continue
    const marker = readMarker(entry.name)
    if (marker === null) {
      // A directory without a marker is only reaped when its name, contents and
      // age prove it is an interrupted side chat (the same gate cleanup uses).
      if (markerlessDirectoryGuard(entry.name)) {
        try {
          cleanupSideChat({ sideChatId: entry.name }, { finalize: true, allowMarkerless: true })
        } catch (error) {
          warn(ctx, `markerless cleanup failed for ${entry.name}: ${messageOf(error)}`)
        }
      }
      continue
    }
    // v0.2 fork-based side chats are incompatible with the current blank-session
    // design; retire them on the first boot after the update instead of leaving
    // a fork tab behind.
    if (typeof marker.sourceCwd === 'string' && isAbsolute(marker.sourceCwd)) {
      try {
        cleanupSideChat({ sideChatId: entry.name }, { finalize: true })
      } catch (error) {
        warn(ctx, `legacy fork quote-ask cleanup failed for ${entry.name}: ${messageOf(error)}`)
      }
      continue
    }
    // Side chats never survive a DSH restart: delete every open one from the
    // previous process. `bootAt` guards a side chat that could have been created
    // while the delayed startup sweep was still pending.
    if (marker.status === 'open' || marker.status === 'closing') {
      const createdAt = Date.parse(marker.createdAt ?? '')
      if (marker.status === 'open' && Number.isFinite(createdAt) && Number.isFinite(settings.bootAt) && createdAt >= bootAt) continue
      try {
        cleanupSideChat({ sideChatId: entry.name }, { finalize: true })
      } catch (error) {
        warn(ctx, `open quote-ask cleanup failed for ${entry.name}: ${messageOf(error)}`)
      }
      continue
    }
    const createdAt = Date.parse(marker.createdAt ?? '')
    if (Number.isFinite(createdAt) && Date.now() - createdAt > ORPHAN_AGE_MS) {
      try {
        cleanupSideChat({ sideChatId: entry.name }, { finalize: true })
      } catch (error) {
        warn(ctx, `orphan cleanup failed for ${entry.name}: ${messageOf(error)}`)
      }
    }
  }
}

/**
 * Best-effort shutdown cleanup: when the Host plugin is disposed (DSH quitting
 * or reloading plugins), delete every still-open side chat synchronously. The
 * startup sweep is the crash-safe fallback if the process exits before this.
 */
function cleanupOpenSideChatsForShutdown() {
  let entries
  try {
    entries = readdirSync(SIDE_ROOT, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeId(entry.name)) continue
    const marker = readMarker(entry.name)
    if (marker === null || (marker.status !== 'open' && marker.status !== 'closing')) continue
    try {
      cleanupSideChat({ sideChatId: entry.name }, { finalize: true })
    } catch {
      /* the startup sweep remains the fallback */
    }
  }
}

/* ------------------------------------------------------------------------- *
 * HTTP routes.
 * ------------------------------------------------------------------------- */

/** Read one JSON object request body, or undefined. */
function readJsonBody(request, limitBytes) {
  return new Promise((resolveBody) => {
    const chunks = []
    let total = 0
    let finished = false
    const finish = (value) => {
      if (finished) return
      finished = true
      resolveBody(value)
    }
    request.on('data', (chunk) => {
      if (finished) return
      total += chunk.length
      if (total > limitBytes) {
        // Refuse the oversized body but keep draining the request so the
        // response can still be written on the same socket.
        finish(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined)
      } catch {
        finish(undefined)
      }
    })
    request.on('error', () => finish(undefined))
    request.on('close', () => finish(undefined))
  })
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

/**
 * Host half: register the routes and the startup sweep.
 * @param {any} ctx host context.
 */
export function apply(ctx) {
  try {
    mkdirSync(SIDE_ROOT, { recursive: true })
  } catch (error) {
    warn(ctx, `cannot create ${SIDE_ROOT}: ${messageOf(error)}`)
  }

  // Run the sweep synchronously before the main window loads its conversation
  // list, so sessions left open by a previous DSH run cannot flash under
  // "未分组". The delayed pass below is a safety net for transient FS errors.
  const bootAt = Date.now()
  try {
    clearAllMainQuotes()
    sweepSideChats(ctx, { bootAt })
  } catch (error) {
    warn(ctx, `synchronous startup sweep failed: ${messageOf(error)}`)
  }
  ctx.effect(
    () => {
      const timer = setTimeout(() => {
        try {
          sweepSideChats(ctx, { bootAt })
        } catch (error) {
          warn(ctx, `startup sweep failed: ${messageOf(error)}`)
        }
      }, 1500)
      return () => clearTimeout(timer)
    },
    'quote-ask: startup sweep',
  )

  // DSH quitting/reloading disposes this plugin; delete open side chats before
  // their sessions become "未分组" leftovers in the next process.
  ctx.effect(
    () => () => {
      cleanupOpenSideChatsForShutdown()
      clearAllMainQuotes()
    },
    'quote-ask: shutdown cleanup',
  )

  // A closed side chat is deleted immediately, but the Host keeps a journal
  // proof for one boot pass because a still-live session can rewrite its
  // projection cache after the first delete. Retire that proof in-process:
  // the first pass re-deletes late artifacts, the second pass clears the
  // journal entry so no record of the side chat survives a normal close.
  const closeFinalizeTimers = new Set()
  function scheduleCloseFinalize(scope, outcome) {
    if (outcome === null || typeof outcome !== 'object' || !isSafeId(outcome.sideChatId)) return
    const sideChatId = outcome.sideChatId
    const sessionId = isSafeId(outcome.sessionId) ? outcome.sessionId : null
    const retry = (delay, finalize) => {
      const timer = setTimeout(() => {
        closeFinalizeTimers.delete(timer)
        try {
          cleanupSideChat(
            { sideChatId, sessionId: sessionId === null ? undefined : sessionId },
            { scoped: scope, finalize },
          )
        } catch {
          /* the startup sweep remains the final safety net */
        }
      }, delay)
      if (typeof timer.unref === 'function') timer.unref()
      closeFinalizeTimers.add(timer)
    }
    retry(5000, false)
    retry(20000, true)
  }
  ctx.effect(
    () => () => {
      for (const timer of closeFinalizeTimers) clearTimeout(timer)
      closeFinalizeTimers.clear()
    },
    'quote-ask: close cleanup finalizers',
  )

  // The side chat context and main-conversation quotes share this model-only
  // system-prompt section.
  let promptSectionReady = false
  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      promptCtx.systemPrompt.section({
        name: 'quote-ask:context',
        order: 9500,
        interpolate: false,
        text: promptSectionText,
      })
      promptSectionReady = true
    } catch (error) {
      warn(ctx, `cannot register quote-ask context section: ${messageOf(error)}`)
    }
  })

  // Move attached main-conversation quotes into the active turn and clear them
  // after the turn. `agent/status` is a fallback for event-shape changes.
  if (typeof ctx.on === 'function') {
    ctx.effect(
      () => {
        let disposeSession = null
        let disposeStatus = null
        try {
          disposeSession = ctx.on('session/event', (session, event) => {
            handleMainQuoteTurnEvent(session, event)
          })
        } catch {
          disposeSession = null
        }
        try {
          disposeStatus = ctx.on('agent/status', (payload) => {
            const agent = payload !== null && typeof payload === 'object' ? payload.agent : null
            const status = payload !== null && typeof payload === 'object' ? payload.status : undefined
            handleMainQuoteAgentStatus(agent, status)
          })
        } catch {
          disposeStatus = null
        }
        return () => {
          if (typeof disposeSession === 'function') disposeSession()
          if (typeof disposeStatus === 'function') disposeStatus()
        }
      },
      'quote-ask: main quote turn lifecycle',
    )
  }

  // Both services are hard requirements. If the connection service is absent the
  // routes are not mounted at all: an unauthenticated destructive endpoint is
  // worse than an unavailable feature (fail closed).
  ctx.inject(['connection', 'webServer'], (scoped) => {
    /** Ask the connection service for the request rejection; missing service = reject. */
    const rejectionFor = (request) => {
      let connection
      try {
        connection = scoped.get('connection')
      } catch {
        connection = undefined
      }
      if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
        return 503
      }
      return connection.requestRejection(request)
    }

    const guard = (request, response) => {
      const rejection = rejectionFor(request)
      if (rejection === undefined) return false
      response.writeHead(rejection)
      response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return true
    }

    /** Destructive routes only accept JSON request bodies. */
    const requireJson = (request, response) => {
      const mediaType = String(request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
      if (mediaType === 'application/json') return true
      response.writeHead(415)
      response.end()
      return false
    }

    const route = (endpoint, handler) =>
      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'exact',
            path: `${ROUTE}/${endpoint}`,
            handler: (request, response) => {
              try {
                Promise.resolve(handler(request, response)).catch((error) => {
                  try {
                    sendJson(response, 500, { ok: false, error: messageOf(error) })
                  } catch {
                    /* socket already gone */
                  }
                })
              } catch (error) {
                try {
                  sendJson(response, 500, { ok: false, error: messageOf(error) })
                } catch {
                  /* socket already gone */
                }
              }
            },
          }),
        `quote-ask: route ${endpoint}`,
      )

    route('ping', (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' })
        response.end()
        return
      }
      const journal = readJournal()
      sendJson(response, 200, { ok: true, version: 4, pending: Object.keys(journal.pending).length })
    })

    route('prepare', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      try {
        if (!promptSectionReady) throw new Error('侧边聊天的上下文注入尚未就绪，请重启 DSH 后再试')
        const quote = normalizeQuoteText(body.quote)
        const quotes = quote.length > 0 ? [{ text: quote, anchor: normalizeQuoteAnchor(body.anchor) }] : []
        const conversation = await readMainConversation(scoped, body.mainSessionId)
        const contextText = buildSideChatContextText(body.mainSessionId, quotes, conversation, [])
        const marker = prepareSideChat(body.sideChatId, body.mainSessionId, contextText, quotes)
        sendJson(response, 200, { ok: true, sideChatId: marker.sideChatId, dir: marker.cwd })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: messageOf(error) })
      }
    })

    route('bind', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      try {
        const marker = bindSideChat(body.sideChatId, body.sessionId, scoped)
        sendJson(response, 200, { ok: true, sideChatId: marker.sideChatId, dir: marker.cwd })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: messageOf(error) })
      }
    })

    route('append-quote', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      try {
        const quoteCount = await appendSideChatQuote(body.sideChatId, body.quote, body.anchor, scoped, body.quotes)
        sendJson(response, 200, { ok: true, quoteCount })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: messageOf(error) })
      }
    })

    route('remove-quote', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      try {
        const quoteCount = await removeSideChatQuote(body.sideChatId, body.quote, body.anchor, scoped)
        sendJson(response, 200, { ok: true, quoteCount })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: messageOf(error) })
      }
    })

    route('attach-main-quote', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      try {
        const quoteCount = attachMainQuote(body.mainSessionId, body.quote, body.anchor)
        sendJson(response, 200, { ok: true, quoteCount })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: messageOf(error) })
      }
    })

    route('remove-main-quote', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      try {
        const quoteCount = removeMainQuote(body.mainSessionId, body.quote, body.anchor)
        sendJson(response, 200, { ok: true, quoteCount })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: messageOf(error) })
      }
    })

    route('start-main-quotes', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      try {
        if (!isSafeId(body.mainSessionId)) throw new Error('invalid mainSessionId')
        sendJson(response, 200, { ok: true, quoteCount: beginMainQuoteTurn(body.mainSessionId) })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: messageOf(error) })
      }
    })

    route('end-main-quotes', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      try {
        if (!isSafeId(body.mainSessionId)) throw new Error('invalid mainSessionId')
        sendJson(response, 200, { ok: true, quoteCount: endMainQuoteTurn(body.mainSessionId) })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: messageOf(error) })
      }
    })

    route('main-quotes-list', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      try {
        if (!isSafeId(body.mainSessionId)) throw new Error('invalid mainSessionId')
        settleMainQuoteTurn(body.mainSessionId, scoped)
        const items = listMainQuotes(body.mainSessionId)
        sendJson(response, 200, { ok: true, quotes: items, quoteCount: items.length })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: messageOf(error) })
      }
    })

    route('touch', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      sendJson(response, 200, { ok: true, touched: touchSideChat(body.sideChatId) })
    })

    route('cleanup', async (request, response) => {
      if (guard(request, response)) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      if (!requireJson(request, response)) return
      const body = await readJsonBody(request, MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(response, 400, { ok: false, error: 'invalid-body' })
        return
      }
      try {
        const outcome = cleanupSideChat(
          { sideChatId: body.sideChatId, sessionId: body.sessionId },
          { scoped, finalize: false },
        )
        // Best-effort list hygiene: drop a legacy archived id once its session is
        // deleted. Failing here never affects the cleanup result.
        if (outcome.sessionId !== null) {
          try {
            const registry = serviceOf(scoped, 'workspaceRegistry')
            if (registry !== undefined && registry !== null && typeof registry.unarchiveSession === 'function') {
              await registry.unarchiveSession(outcome.sessionId)
            }
          } catch {
            /* the archive set tolerates ids whose session is gone */
          }
        }
        scheduleCloseFinalize(scoped, outcome)
        sendJson(response, 200, {
          ok: true,
          sideChatId: outcome.sideChatId,
          sessionId: outcome.sessionId,
          removed: outcome.removed,
          failed: outcome.failed,
        })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: messageOf(error) })
      }
    })
  })
}

/** Exposed for a future contract test without enabling the plugin. */
export const __testHooks = {
  inside,
  projectKey,
  encodeSegment,
  removeOwnedPath,
  cleanupSideChat,
  cleanupOpenSideChatsForShutdown,
  sweepSideChats,
  prepareSideChat,
  bindSideChat,
  touchSideChat,
  normalizeQuoteText,
  renderMainEvent,
  buildSideChatContextText,
  sideChatPromptContext,
  appendSideChatQuote,
  attachMainQuote,
  removeMainQuote,
  listMainQuotes,
  buildMainQuoteContextText,
  mainQuotePromptContext,
  handleMainQuoteTurnEvent,
  clearAllMainQuotes,
}
