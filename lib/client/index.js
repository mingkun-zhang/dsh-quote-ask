/**
 * dsh-quote-ask — browser half.
 *
 * Hand-written client module in the DSH client-module form: this file only
 * registers a lazy factory (`window.__ModuleLoader__.load`); everything else
 * runs when the factory materialises. No bundler is involved.
 *
 * Product shape (v0.5):
 *   - A side chat is a blank scratch session. Its DOM row is hidden from the
 *     sidebar conversation list by this plugin; it is never archived (the DSH
 *     archived-session gate would block every model step). The visible
 *     transcript starts empty and the composer sits at the bottom like a normal
 *     conversation.
 *   - Selected excerpts are kept as a compact "已选文本片段" chip inside the
 *     composer card; clicking it opens a panel that shows every quote on its own
 *     line. Right-clicking another selection in the main conversation offers
 *     "添加到侧边聊天引用" to append to the same side chat.
 *   - The Host injects the main conversation plus all quotes as a model-only
 *     system-prompt section (`<quote-ask>/context.md`), so the model answers the
 *     quote-ask question with full main context while the main conversation is
 *     never appended to.
 *   - Closing the tab cancels work and deletes every durable artifact of the
 *     scratch session (workspace, context, session log, projection cache, spill,
 *     client draft) through the Host half.
 *
 * What it registers (all official extension points):
 *   - a `quoteask` resource protocol (address:
 *     `dsh-resource://quoteask/session/<sessionId>`), which retains a
 *     `SessionReference` for the side conversation;
 *   - a right-sidebar tab type (`kind: quoteask`) plus its body;
 *   - a quote chip in the composer tool row (`conversation.input.left`);
 *   - a close handler that asks the Host half to delete the side chat;
 *   - a selection menu host in `shell.overlay`: right-clicking a text
 *     selection inside the main transcript offers "在侧边聊天中提问" and, while
 *     a side chat is open, "添加到侧边聊天引用".
 *
 * @module dsh-quote-ask/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-quote-ask',
  factory(require) {
    'use strict'

    var React = require('react')
    var ReactDOM = require('react-dom')
    var h = React.createElement

    /** Package name; must equal package.json name and the Host row id. */
    var TAB_ID = 'dsh-quote-ask'
    /** Right-sidebar tab kind; unique, never a builtin kind. */
    var TAB_KIND = 'quoteask'
    /** Slot identity of the side conversation body (declared by the tab registration). */
    var CONVERSATION_SLOT = 'dsh-quote-ask.conversation'
    /** Resource protocol scheme. */
    var PROTOCOL = 'quoteask'
    /** Resource address prefix for one quote-ask session. */
    var ADDRESS_PREFIX = 'dsh-resource://' + PROTOCOL + '/session/'
    /** Selection-menu host identity inside `shell.overlay`. */
    var MENU_ID = 'dsh-quote-ask.selection-menu'
    /** Absolute Host route prefix. */
    var ROUTE = '/dsh-quote-ask'
    /** localStorage keys owned by this plugin. */
    var SESSIONS_KEY = 'dsh-quote-ask.sessions.v1'
    var PENDING_KEY = 'dsh-quote-ask.pending.v1'
    /** localStorage map: main session id -> quote attachments for the next turn. */
    var MAIN_QUOTES_KEY = 'dsh-quote-ask.main-quotes.v1'
    /** Ids are uuids; this mirrors the Host-side deletion whitelist. */
    var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
    /** Longest excerpt kept in one quote entry and the hidden context file. */
    var MAX_QUOTE_CHARS = 12000
    /** Window event fired after the local quote-ask entry map changes. */
    var ENTRIES_CHANGED_EVENT = 'dsh-quote-ask:entries-changed'
    /** CSS Custom Highlight registry key for quoted text in the transcript. */
    var HIGHLIGHT_NAME = 'dsh-quote-ask'
    /** Marker attribute on the fixed badge layer (never inside the transcript). */
    var BADGE_LAYER_ATTR = 'data-dsh-quote-ask-badges'

    /* --------------------------------------------------------------------- *
     * Tiny utilities (no DSH imports: the module table only guarantees react
     * and the platform base modules).
     * --------------------------------------------------------------------- */

    /** @param {unknown} error @returns {string} */
    function messageOf(error) {
      if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
      return String(error)
    }

    function sleep(milliseconds) {
      return new Promise(function (resolve) {
        window.setTimeout(resolve, milliseconds)
      })
    }

    function createId() {
      try {
        if (typeof window.crypto === 'object' && window.crypto !== null && typeof window.crypto.randomUUID === 'function') {
          return window.crypto.randomUUID()
        }
      } catch {
        /* fall through to the timestamp form */
      }
      return 'sc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)
    }

    function addressOf(sessionId) {
      return ADDRESS_PREFIX + encodeURIComponent(String(sessionId))
    }

    /** @param {unknown} address @returns {string | null} */
    function parseAddress(address) {
      if (typeof address !== 'string' || address.indexOf(ADDRESS_PREFIX) !== 0) return null
      var tail = address.slice(ADDRESS_PREFIX.length)
      var cut = tail.search(/[/?#]/)
      var id = cut === -1 ? tail : tail.slice(0, cut)
      try {
        id = decodeURIComponent(id)
      } catch {
        return null
      }
      return SAFE_ID.test(id) ? id : null
    }

    /** Normalise one selected excerpt for display and for the Host context file. */
    function normalizeQuote(raw) {
      var text = typeof raw === 'string' ? raw : ''
      text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()
      if (text.length > MAX_QUOTE_CHARS) {
        text = text.slice(0, MAX_QUOTE_CHARS) + '\n…（选中内容过长，已截断）'
      }
      return text
    }

    /* --------------------------------------------------------------------- *
     * localStorage state: one entry per side chat (maps a closed tab back to
     * its cleanup id), plus the retry queue for cleanups that could not reach
     * the Host and the graveyard of deleted session ids whose client-side
     * draft keys still need to be removed.
     * --------------------------------------------------------------------- */

    function readJsonStore(key) {
      try {
        var raw = window.localStorage.getItem(key)
        if (!raw) return null
        var parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    function writeJsonStore(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* a full or disabled storage must not break the feature */
      }
    }

    function readSessionEntries() {
      var value = readJsonStore(SESSIONS_KEY)
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    function getSessionEntry(sessionId) {
      if (typeof sessionId !== 'string') return null
      var entries = readSessionEntries()
      return Object.prototype.hasOwnProperty.call(entries, sessionId) ? entries[sessionId] : null
    }

    function putSessionEntry(sessionId, entry) {
      var entries = readSessionEntries()
      entries[sessionId] = entry
      writeJsonStore(SESSIONS_KEY, entries)
      notifyEntriesChanged()
    }

    function removeSessionEntry(sessionId) {
      var entries = readSessionEntries()
      if (!Object.prototype.hasOwnProperty.call(entries, sessionId)) return
      delete entries[sessionId]
      if (Object.keys(entries).length === 0) {
        try {
          window.localStorage.removeItem(SESSIONS_KEY)
        } catch {
          /* storage unavailable */
        }
      } else {
        writeJsonStore(SESSIONS_KEY, entries)
      }
      notifyEntriesChanged()
    }

    /** Quotes stored on one quote-ask entry, with their optional exact anchors. */
    function quoteItemsOfEntry(entry) {
      if (entry === null || typeof entry !== 'object') return []
      var items = []
      if (Array.isArray(entry.quotes)) {
        for (var item of entry.quotes) {
          if (typeof item === 'string') {
            if (item.trim().length > 0) items.push({ text: item, anchor: null })
          } else if (item !== null && typeof item === 'object' && typeof item.text === 'string' && item.text.trim().length > 0) {
            items.push({ text: item.text, anchor: item.anchor !== undefined ? item.anchor : null })
          }
        }
      } else if (typeof entry.quote === 'string' && entry.quote.trim().length > 0) {
        items.push({ text: entry.quote, anchor: null })
      }
      return items
    }

    /** Plain quote texts (chip label and counts). */
    function quotesOfEntry(entry) {
      return quoteItemsOfEntry(entry).map(function (item) {
        return item.text
      })
    }

    /* --------------------------------------------------------------------- *
     * "添加至对话": quote attachments for the MAIN conversation's next turn.
     * The Host owns the model-injection state; this map only drives the chip.
     * --------------------------------------------------------------------- */

    function normalizeMainQuoteItems(rawItems) {
      var items = []
      if (!Array.isArray(rawItems)) return items
      for (var item of rawItems) {
        var text = ''
        var anchor = null
        if (typeof item === 'string') {
          text = normalizeQuote(item)
        } else if (item !== null && typeof item === 'object') {
          text = normalizeQuote(item.text)
          anchor = item.anchor !== undefined ? item.anchor : null
        }
        if (text.length > 0) items.push({ text: text, anchor: anchor })
      }
      return items
    }

    function readMainQuoteMap() {
      var value = readJsonStore(MAIN_QUOTES_KEY)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
      return value
    }

    function mainQuoteItemsForSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return []
      var map = readMainQuoteMap()
      return normalizeMainQuoteItems(map[sessionId])
    }

    function setMainQuoteItemsForSession(sessionId, items) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      var map = readMainQuoteMap()
      if (items.length === 0) delete map[sessionId]
      else map[sessionId] = items
      if (Object.keys(map).length === 0) {
        try {
          window.localStorage.removeItem(MAIN_QUOTES_KEY)
        } catch {
          /* storage unavailable */
        }
      } else {
        writeJsonStore(MAIN_QUOTES_KEY, map)
      }
      notifyEntriesChanged()
    }

    function clearMainQuotesLocal() {
      try {
        window.localStorage.removeItem(MAIN_QUOTES_KEY)
      } catch {
        /* storage unavailable */
      }
      notifyEntriesChanged()
    }

    /** Newest open side chat opened from one main conversation, or null. */
    function findEntryForMainSession(mainSessionId) {
      if (typeof mainSessionId !== 'string' || mainSessionId.length === 0) return null
      var entries = readSessionEntries()
      var best = null
      var bestCreatedAt = -1
      for (var sessionId of Object.keys(entries)) {
        var entry = entries[sessionId]
        if (entry === null || typeof entry !== 'object') continue
        if (entry.mainSessionId !== mainSessionId) continue
        var createdAt = Number(entry.createdAt)
        if (!Number.isFinite(createdAt)) createdAt = 0
        if (createdAt < bestCreatedAt) continue
        bestCreatedAt = createdAt
        best = { sessionId: sessionId, entry: entry }
      }
      return best
    }

    function notifyEntriesChanged() {
      try {
        if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
          window.dispatchEvent(new window.CustomEvent(ENTRIES_CHANGED_EVENT))
        }
      } catch {
        /* a missing CustomEvent only means the chip refreshes on its next mount */
      }
    }

    function subscribeEntriesChanged(listener) {
      try {
        window.addEventListener(ENTRIES_CHANGED_EVENT, listener)
        return function () {
          window.removeEventListener(ENTRIES_CHANGED_EVENT, listener)
        }
      } catch {
        return function () {}
      }
    }

    function readPendingList() {
      var value = readJsonStore(PENDING_KEY)
      if (!Array.isArray(value)) return []
      return value.filter(function (item) {
        return item !== null && typeof item === 'object'
      })
    }

    function writePendingList(list) {
      if (list.length === 0) {
        try {
          window.localStorage.removeItem(PENDING_KEY)
        } catch {
          /* storage unavailable */
        }
        return
      }
      writeJsonStore(PENDING_KEY, list)
    }

    function addPendingItem(item) {
      var list = readPendingList().filter(function (existing) {
        if (item.sideChatId && existing.sideChatId === item.sideChatId) return false
        if (!item.sideChatId && existing.sessionId === item.sessionId) return false
        return true
      })
      list.push(item)
      writePendingList(list)
    }

    function removePendingItem(sideChatId, sessionId) {
      writePendingList(
        readPendingList().filter(function (existing) {
          if (sideChatId && existing.sideChatId === sideChatId) return false
          if (!sideChatId && sessionId && existing.sessionId === sessionId) return false
          return true
        }),
      )
    }

    /* --------------------------------------------------------------------- *
     * DSH's own per-session client state.
     *
     * The shared Conversation UI persists its composer draft at
     * `dsh.conversation.<sessionId>` in localStorage. Our prefill puts the
     * quoted excerpt there, so deleting only the Host-side session would leave
     * that draft (and the excerpt) behind on disk. The quote-ask close path
     * therefore also removes every `dsh.conversation.<sessionId>[...]` key and
     * remembers recently deleted ids so a failed retry can finish the scrub.
     * --------------------------------------------------------------------- */

    var GRAVEYARD_KEY = 'dsh-quote-ask.graveyard.v1'
    /** Header of the composer prefill; only this plugin writes it. */
    var LEGACY_DRAFT_MARKER = '我在 DSH 主对话中选中'

    function readGraveyard() {
      var value = readJsonStore(GRAVEYARD_KEY)
      if (!Array.isArray(value)) return []
      return value.filter(function (item) {
        return typeof item === 'string' && item.length > 0
      })
    }

    function rememberDeletedSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      var list = readGraveyard()
      if (list.indexOf(sessionId) !== -1) return
      list.push(sessionId)
      writeJsonStore(GRAVEYARD_KEY, list.slice(-100))
    }

    /** Drop the retry record once the session's drafts and Host artifacts are gone. */
    function forgetDeletedSessionRecord(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      var list = readGraveyard()
      var next = list.filter(function (item) {
        return item !== sessionId
      })
      if (next.length === list.length) return
      if (next.length === 0) {
        try {
          window.localStorage.removeItem(GRAVEYARD_KEY)
        } catch {
          /* storage unavailable */
        }
        return
      }
      writeJsonStore(GRAVEYARD_KEY, next)
    }

    /** Remove DSH's draft/view cache for one deleted quote-ask session. */
    function removeConversationDraftKeys(sessionId) {
      try {
        var storage = window.localStorage
        if (!storage || typeof storage.length !== 'number') return
        var prefix = 'dsh.conversation.' + sessionId
        var doomed = []
        for (var index = 0; index < storage.length; index += 1) {
          var key = storage.key(index)
          if (typeof key === 'string' && (key === prefix || key.indexOf(prefix + '.') === 0)) doomed.push(key)
        }
        for (var removeIndex = 0; removeIndex < doomed.length; removeIndex += 1) {
          storage.removeItem(doomed[removeIndex])
        }
      } catch {
        /* storage unavailable; the host cleanup still removes the session */
      }
    }

    /** Whether DSH still keeps any draft/view key for one session. */
    function hasConversationDraftKeys(sessionId) {
      try {
        var storage = window.localStorage
        if (!storage || typeof storage.length !== 'number') return false
        var prefix = 'dsh.conversation.' + sessionId
        for (var index = 0; index < storage.length; index += 1) {
          var key = storage.key(index)
          if (typeof key === 'string' && (key === prefix || key.indexOf(prefix + '.') === 0)) return true
        }
        return false
      } catch {
        return false
      }
    }

    /**
     * DSH can rewrite the composer draft during tab unmount, after our close
     * handler already scrubbed it. Remove the keys once more shortly after
     * cleanup, and only then retire the graveyard record.
     */
    function scheduleDraftKeyScrub(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      removeConversationDraftKeys(sessionId)
      if (!hasConversationDraftKeys(sessionId)) forgetDeletedSessionRecord(sessionId)
      var delays = [1500, 6000]
      for (var index = 0; index < delays.length; index += 1) {
        window.setTimeout(function () {
          try {
            removeConversationDraftKeys(sessionId)
            if (!hasConversationDraftKeys(sessionId)) forgetDeletedSessionRecord(sessionId)
          } catch {
            /* storage unavailable */
          }
        }, delays[index])
      }
    }

    /** Keep only graveyard ids whose draft keys still exist (late-write retries). */
    function pruneGraveyardRecords() {
      var list = readGraveyard()
      var kept = list.filter(function (sessionId) {
        return hasConversationDraftKeys(sessionId)
      })
      if (kept.length !== list.length) {
        if (kept.length === 0) {
          try {
            window.localStorage.removeItem(GRAVEYARD_KEY)
          } catch {
            /* storage unavailable */
          }
        } else {
          writeJsonStore(GRAVEYARD_KEY, kept)
        }
      }
    }

    function forgetLocalSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      rememberDeletedSession(sessionId)
      removeConversationDraftKeys(sessionId)
    }

    /**
     * One-time scrub for drafts written by this plugin before the close path
     * cleared DSH's own draft keys. The prompt header is unique to this plugin,
     * so only our own leftover drafts are removed.
     */
    function scrubLegacySideChatLocalState() {
      try {
        var storage = window.localStorage
        if (!storage || typeof storage.length !== 'number') return
        var graveyard = readGraveyard()
        for (var id = 0; id < graveyard.length; id += 1) removeConversationDraftKeys(graveyard[id])
        var doomed = []
        for (var index = 0; index < storage.length; index += 1) {
          var key = storage.key(index)
          if (typeof key !== 'string' || key.indexOf('dsh.conversation.') !== 0) continue
          var value = storage.getItem(key)
          if (typeof value === 'string' && value.indexOf(LEGACY_DRAFT_MARKER) !== -1) doomed.push(key)
        }
        for (var removeIndex = 0; removeIndex < doomed.length; removeIndex += 1) {
          storage.removeItem(doomed[removeIndex])
        }
        pruneGraveyardRecords()
      } catch {
        /* a broken storage must not stop plugin activation */
      }
    }

    /* --------------------------------------------------------------------- *
     * Startup purge: side chats are session-scoped. When DSH is quit and
     * reopened, remove their local entries, drafts and restored sidebar tabs so
     * no "未分组" leftovers or broken tabs survive. A page reload (Ctrl+R) keeps
     * them, because the Host process and quote-ask sessions are still alive.
     * --------------------------------------------------------------------- */

    var BOOT_MARKER_KEY = 'dsh-quote-ask.booted.v1'

    function shouldPurgeSideChatState() {
      try {
        var session = window.sessionStorage
        if (session && typeof session.getItem === 'function') {
          if (session.getItem(BOOT_MARKER_KEY) === '1') return false
          session.setItem(BOOT_MARKER_KEY, '1')
          return true
        }
      } catch {
        /* fall through to navigation timing */
      }
      try {
        var navigation = window.performance !== undefined && typeof window.performance.getEntriesByType === 'function'
          ? window.performance.getEntriesByType('navigation')[0]
          : null
        return !(navigation !== null && navigation !== undefined && navigation.type === 'reload')
      } catch {
        return true
      }
    }

    /**
     * Remove quoteask tabs from DSH's saved right-sidebar layouts, leaving other
     * plugins' tabs intact. Returns the removed {sessionId, tabId} pairs so any
     * already-restored tabs can be closed through the sidebar API.
     */
    function scrubSideChatTabsFromSavedLayouts() {
      var pairs = []
      try {
        var storage = window.localStorage
        if (!storage || typeof storage.length !== 'number') return pairs
        var keys = []
        for (var index = 0; index < storage.length; index += 1) {
          var key = storage.key(index)
          if (typeof key === 'string' && key.indexOf('dsh.sidebar-right.') === 0) keys.push(key)
        }
        for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          var storageKey = keys[keyIndex]
          var parsed = null
          try {
            parsed = JSON.parse(storage.getItem(storageKey))
          } catch {
            continue
          }
          var bySession = parsed !== null && typeof parsed === 'object' ? parsed.bySession : null
          if (bySession === null || typeof bySession !== 'object') continue
          var changed = false
          for (var sessionId of Object.keys(bySession)) {
            var surface = bySession[sessionId]
            var layout = surface !== null && typeof surface === 'object' ? surface.layout : null
            if (layout === null || typeof layout !== 'object') continue
            var removed = {}
            if (layout.tabs !== null && typeof layout.tabs === 'object') {
              for (var tabId of Object.keys(layout.tabs)) {
                var tab = layout.tabs[tabId]
                if (tab === null || typeof tab !== 'object') continue
                var contentId = typeof tab.contentId === 'string' ? tab.contentId : ''
                if (tab.kind === 'quoteask' || contentId.indexOf('dsh-resource://quoteask/') === 0
                  || tab.kind === 'sidechat' || contentId.indexOf('dsh-resource://sidechat/') === 0) {
                  delete layout.tabs[tabId]
                  removed[tabId] = true
                  changed = true
                }
              }
            }
            var removedIds = Object.keys(removed)
            if (removedIds.length === 0) continue
            pairs.push({ sessionId: sessionId, tabIds: removedIds })
            if (layout.nodes !== null && typeof layout.nodes === 'object') {
              for (var paneId of Object.keys(layout.nodes)) {
                var pane = layout.nodes[paneId]
                if (pane === null || typeof pane !== 'object' || !Array.isArray(pane.tabs)) continue
                pane.tabs = pane.tabs.filter(function (id) {
                  return removed[id] !== true
                })
                if (typeof pane.activeTabId === 'string' && removed[pane.activeTabId] === true) {
                  if (pane.tabs.length > 0) pane.activeTabId = pane.tabs[0]
                  else delete pane.activeTabId
                }
              }
            }
          }
          if (changed) {
            try {
              storage.setItem(storageKey, JSON.stringify(parsed))
            } catch {
              /* storage unavailable */
            }
          }
        }
      } catch {
        /* layout scrub is best effort */
      }
      return pairs
    }

    /**
     * One-time cleanup for the pre-rename plugin. The old localStorage keys and
     * restored ``sidechat`` tabs must not survive the rebrand; the new Host also
     * uses a different data directory.
     */
    function purgeLegacyQuoteAskState() {
      try {
        var storage = window.localStorage
        if (!storage) return
        var legacySessionsKey = 'dsh-side-chat.sessions.v1'
        try {
          var oldEntries = JSON.parse(storage.getItem(legacySessionsKey) || '{}')
          for (var oldSessionId of Object.keys(oldEntries)) removeConversationDraftKeys(oldSessionId)
        } catch {
          /* ignore malformed legacy state */
        }
        var legacyKeys = [
          legacySessionsKey,
          'dsh-side-chat.pending.v1',
          'dsh-side-chat.graveyard.v1',
          'dsh-side-chat.main-quotes.v1',
        ]
        for (var key of legacyKeys) storage.removeItem(key)
      } catch {
        /* storage unavailable */
      }
    }

    function purgeSideChatStateOnBoot(scope) {
      if (!shouldPurgeSideChatState()) return
      try {
        var entries = readSessionEntries()
        for (var sessionId of Object.keys(entries)) removeConversationDraftKeys(sessionId)
        var storage = window.localStorage
        if (storage) {
          storage.removeItem(SESSIONS_KEY)
          storage.removeItem(PENDING_KEY)
          storage.removeItem(GRAVEYARD_KEY)
          storage.removeItem(MAIN_QUOTES_KEY)
        }
      } catch {
        /* storage unavailable */
      }
      var staleTabs = scrubSideChatTabsFromSavedLayouts()
      notifyEntriesChanged()
      if (staleTabs.length === 0) return
      var delays = [300, 1200, 2600]
      for (var delayIndex = 0; delayIndex < delays.length; delayIndex += 1) {
        window.setTimeout(function () {
          try {
            var sidebar = scope.sidebarRight
            if (sidebar === null || sidebar === undefined || typeof sidebar.closeIn !== 'function') return
            for (var pairIndex = 0; pairIndex < staleTabs.length; pairIndex += 1) {
              var pair = staleTabs[pairIndex]
              for (var tabIndex = 0; tabIndex < pair.tabIds.length; tabIndex += 1) {
                try {
                  sidebar.closeIn(pair.sessionId, pair.tabIds[tabIndex])
                } catch {
                  /* tab may not be adopted yet */
                }
              }
            }
          } catch {
            /* best effort */
          }
        }, delays[delayIndex])
      }
    }

    /* --------------------------------------------------------------------- *
     * Host RPC (plain same-origin POST; absolute path, which the Desktop
     * preload bridge forwards and the Web page resolves relative to its own
     * origin).
     * --------------------------------------------------------------------- */

    async function hostPost(endpoint, payload) {
      var response = await fetch(ROUTE + '/' + endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      var data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || data === null || data.ok !== true) {
        var detail = data && typeof data.error === 'string' ? data.error : 'HTTP ' + String(response.status)
        throw new Error(detail)
      }
      return data
    }

    /* --------------------------------------------------------------------- *
     * Right-sidebar tab: title, body and the embedded conversation.
     * --------------------------------------------------------------------- */

    function titleForAddress(address) {
      try {
        var sessionId = parseAddress(address)
        var entry = sessionId === null ? null : getSessionEntry(sessionId)
        var mainTitle = entry !== null && typeof entry.mainTitle === 'string' ? entry.mainTitle : ''
        if (mainTitle.length > 0) return '引问 · ' + mainTitle
      } catch {
        /* fall back to the fixed title */
      }
      return '引问'
    }

    /** Read one conversation's display title from the client list snapshot. */
    function readMainTitle(scope, sessionId) {
      try {
        var state = scope.sessions.list && typeof scope.sessions.list.getSnapshot === 'function'
          ? scope.sessions.list.getSnapshot()
          : null
        var summary = state && state.byId ? state.byId[sessionId] : null
        var title = summary && typeof summary.title === 'string' ? summary.title.trim() : ''
        return title.length > 0 ? title.slice(0, 80) : ''
      } catch {
        return ''
      }
    }

    /** Force the shared conversation occurrence to its Chat view (official ui-subagent pattern). */
    function SideChatViews(props) {
      return props.renderSlot('conversation.session', { view: 'chat' })
    }

    function makeConversationPanel() {
      return function SideChatConversation(props) {
        var sessionId = typeof props.sessionId === 'string' ? props.sessionId : null
        var body = null
        try {
          body = props.renderFactorySlot(
            'conversation.content',
            {
              variant: 'embedded',
              phase: 'active',
              hero: false,
            },
            { slots: { views: SideChatViews } },
          )
        } catch (error) {
          body = h('div', { className: 'dsh-quote-ask-message' }, '侧边聊天界面加载失败：' + messageOf(error))
        }
        return h(
          'div',
          { className: 'dsh-quote-ask-conversation', 'data-dsh-quote-ask-conversation': sessionId || '' },
          body,
        )
      }
    }

    function makeTabBody() {
      return function SideChatTabBody(props) {
        var info = props.useTabInfo()
        var tab = info && info.tab ? info.tab : null
        var address = tab && typeof tab.contentId === 'string' ? tab.contentId : ''
        var resource = props.useResource(address)
        var rootRef = React.useRef(null)
        React.useEffect(
          function () {
            // Fill the pane body down to the window bottom regardless of what
            // height its slot wrapper establishes: the conversation then has a
            // definite height and its sticky composer sits at the bottom.
            try {
              var root = rootRef.current
              if (root === null || root === undefined) return undefined
              var apply = function () {
                try {
                  var rect = root.getBoundingClientRect()
                  if (rect.width === 0 && rect.height === 0) return
                  var available = Math.max(240, Math.floor(window.innerHeight - rect.top - 8))
                  root.style.height = available + 'px'
                  root.style.minHeight = available + 'px'
                } catch {
                  /* keep the CSS fallback */
                }
              }
              apply()
              window.addEventListener('resize', apply)
              return function () {
                window.removeEventListener('resize', apply)
              }
            } catch {
              return undefined
            }
          },
          [address, resource.status],
        )
        if (!address) return null
        if (resource.status === 'failed') {
          return h('div', { className: 'dsh-quote-ask-message' }, '这条侧边聊天已经结束：会话不存在或已被清理。')
        }
        var value = resource.value
        if (!value || !value.reference) {
          return h('div', { className: 'dsh-quote-ask-message' }, '正在打开侧边聊天…')
        }
        var Provider = props.SessionProvider
        if (!Provider) {
          return h('div', { className: 'dsh-quote-ask-message' }, '侧边聊天无法渲染：缺少会话上下文。')
        }
        var inner = props.renderSlot ? props.renderSlot(CONVERSATION_SLOT, {}) : null
        // The pane body gives this root no definite height in some layouts, so
        // the tab root and its conversation wrapper both participate in the
        // flex chain: the wrapper stretches horizontally (column flex) and grows
        // vertically, which keeps the composer at the bottom.
        return h(
          'div',
          { ref: rootRef, className: 'dsh-quote-ask-tab', 'data-dsh-quote-ask-tab': address },
          h('div', { className: 'dsh-quote-ask-conversation' }, h(Provider, { session: value.reference }, inner)),
        )
      }
    }

    /* --------------------------------------------------------------------- *
     * Quote chip inside the composer tool row. The excerpts themselves are a
     * model-side concern; the chip is the only visible representation and its
     * panel lists every quote on its own line.
     * --------------------------------------------------------------------- */

    function makeQuoteChip(scope) {
      return function SideChatQuoteChip(props) {
        var version = React.useState(0)
        var setVersion = version[1]
        var openState = React.useState(false)
        var open = openState[0]
        var setOpen = openState[1]
        var rectState = React.useState(null)
        var rect = rectState[0]
        var setRect = rectState[1]
        var deletingState = React.useState(null)
        var deletingIndex = deletingState[0]
        var setDeletingIndex = deletingState[1]
        var errorState = React.useState(null)
        var deleteError = errorState[0]
        var setDeleteError = errorState[1]
        var buttonRef = React.useRef(null)
        var hoverOpenTimerRef = React.useRef(null)
        var hoverCloseTimerRef = React.useRef(null)
        var sessionId = typeof props.sessionId === 'string' ? props.sessionId : null
        var sideEntry = sessionId === null ? null : getSessionEntry(sessionId)
        var isSide = sideEntry !== null
        var quoteItems = isSide ? quoteItemsOfEntry(sideEntry) : mainQuoteItemsForSession(sessionId)
        // Badges are numbered across the main conversation (main attachments
        // first, then open side chats), so the chip panel must show the same
        // numbers instead of restarting at 1 for every side chat.
        var quoteNumberBase = isSide ? sideQuoteNumberOffset(sideEntry) : 0
        var quotes = quoteItems.map(function (item) {
          return item.text
        })
        React.useEffect(function () {
          var off = subscribeEntriesChanged(function () {
            setVersion(function (value) {
              return value + 1
            })
          })
          return function () {
            off()
            if (hoverOpenTimerRef.current !== null) window.clearTimeout(hoverOpenTimerRef.current)
            if (hoverCloseTimerRef.current !== null) window.clearTimeout(hoverCloseTimerRef.current)
          }
        }, [])
        React.useEffect(
          function () {
            if (!open) return undefined
            function onPointerDown(event) {
              var target = event.target
              if (target !== null && typeof target.closest === 'function'
                && (target.closest('.dsh-quote-ask-quotes-panel') !== null || target.closest('.dsh-quote-ask-quote-chip') !== null)) {
                return
              }
              setOpen(false)
            }
            function onKeyDown(event) {
              if (event.key === 'Escape') setOpen(false)
            }
            document.addEventListener('pointerdown', onPointerDown, true)
            document.addEventListener('keydown', onKeyDown, true)
            return function () {
              document.removeEventListener('pointerdown', onPointerDown, true)
              document.removeEventListener('keydown', onKeyDown, true)
            }
          },
          [open],
        )
        // The panel is fixed-positioned from the chip's measured rect. Re-measure
        // on resize/scroll so it never overflows after the window or sidebar
        // changes size (including fullscreen).
        React.useEffect(
          function () {
            if (!open) return undefined
            function syncRect() {
              var button = buttonRef.current
              if (button === null || button === undefined || typeof button.getBoundingClientRect !== 'function') return
              var next = button.getBoundingClientRect()
              if (next.width === 0 && next.height === 0) {
                setOpen(false)
                return
              }
              setRect(next)
            }
            syncRect()
            window.addEventListener('resize', syncRect)
            window.addEventListener('scroll', syncRect, true)
            return function () {
              window.removeEventListener('resize', syncRect)
              window.removeEventListener('scroll', syncRect, true)
            }
          },
          [open],
        )
        // Main-conversation attachments live in the Host; after the awaiting turn
        // ends the Host clears them, so refresh the chip when the session goes
        // from running to idle (and once on mount).
        React.useEffect(
          function () {
            if (isSide || sessionId === null || quoteItems.length === 0) return undefined
            var cancelled = false
            var reference = null
            var off = null
            var wasRunning = false
            var initialized = false
            function check() {
              try {
                var snapshot = reference !== null ? reference.binding.session.getSnapshot() : null
                var running = snapshot !== null && typeof snapshot === 'object' && snapshot.running === true
                if (!initialized) {
                  // Do not treat an already-running turn as a fresh turn when the
                  // chip mounts mid-answer: attachments belong to the NEXT turn.
                  initialized = true
                  wasRunning = running
                  return
                }
                if (running && !wasRunning) {
                  hostPost('start-main-quotes', { mainSessionId: sessionId }).catch(function () {
                    /* Host turn events are the primary path */
                  })
                }
                if (!running && wasRunning) {
                  hostPost('end-main-quotes', { mainSessionId: sessionId }).catch(function () {
                    /* Host turn events are the primary path */
                  }).then(function () {
                    window.setTimeout(function () {
                      if (!cancelled) refreshMainQuotesFromHost(scope, sessionId)
                    }, 200)
                  })
                }
                wasRunning = running
              } catch {
                /* session reference may be closing */
              }
            }
            try {
              reference = scope.sessions.retain(sessionId, { source: 'mainQuotesChip' })
            } catch {
              return undefined
            }
            Promise.resolve(reference.ready).then(function () {
              if (cancelled) return
              try {
                off = reference.binding.session.subscribe(check)
                check()
              } catch {
                /* best effort */
              }
            }).catch(function () {
              /* the main session may already be gone */
            })
            refreshMainQuotesFromHost(scope, sessionId)
            return function () {
              cancelled = true
              if (typeof off === 'function') {
                try {
                  off()
                } catch {
                  /* already detached */
                }
              }
              try {
                reference.release()
              } catch {
                /* already released */
              }
            }
          },
          [isSide, sessionId, quoteItems.length],
        )
        if (quotes.length === 0) return null
        function toggle() {
          var button = buttonRef.current
          if (button !== null && typeof button.getBoundingClientRect === 'function') {
            setRect(button.getBoundingClientRect())
          }
          setOpen(!open)
        }
        function clearHoverOpenTimer() {
          if (hoverOpenTimerRef.current !== null) {
            window.clearTimeout(hoverOpenTimerRef.current)
            hoverOpenTimerRef.current = null
          }
        }
        function clearHoverCloseTimer() {
          if (hoverCloseTimerRef.current !== null) {
            window.clearTimeout(hoverCloseTimerRef.current)
            hoverCloseTimerRef.current = null
          }
        }
        function scheduleHoverClose() {
          clearHoverCloseTimer()
          hoverCloseTimerRef.current = window.setTimeout(function () {
            hoverCloseTimerRef.current = null
            setOpen(false)
          }, 280)
        }
        function onChipEnter() {
          clearHoverCloseTimer()
          if (open) return
          clearHoverOpenTimer()
          hoverOpenTimerRef.current = window.setTimeout(function () {
            hoverOpenTimerRef.current = null
            var button = buttonRef.current
            if (button !== null && typeof button.getBoundingClientRect === 'function') {
              setRect(button.getBoundingClientRect())
            }
            setOpen(true)
          }, 320)
        }
        function deleteQuote(index) {
          var item = quoteItems[index]
          if (item === undefined) return
          setDeletingIndex(index)
          setDeleteError(null)
          if (isSide) {
            var sideChatId = sideEntry !== null && typeof sideEntry.sideChatId === 'string' ? sideEntry.sideChatId : null
            if (sideChatId === null) {
              setDeletingIndex(null)
              setDeleteError('侧边聊天不存在或已关闭')
              return
            }
            removeQuoteFromSideChat(scope, sessionId, sideChatId, item.text, item.anchor).then(
              function () {
                setDeletingIndex(null)
              },
              function (error) {
                setDeletingIndex(null)
                setDeleteError(messageOf(error))
              },
            )
            return
          }
          removeMainQuoteFromConversation(scope, sessionId, item.text, item.anchor).then(
            function () {
              setDeletingIndex(null)
            },
            function (error) {
              setDeletingIndex(null)
              setDeleteError(messageOf(error))
            },
          )
        }
        var chip = h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'dsh-quote-ask-quote-chip' + (open ? ' dsh-quote-ask-quote-chip-open' : ''),
            'aria-expanded': open ? 'true' : 'false',
            title: isSide ? '查看或删除引用片段' : '查看或删除本次提问附加的引用',
            onClick: toggle,
            onMouseEnter: onChipEnter,
            onMouseLeave: function () {
              clearHoverOpenTimer()
              scheduleHoverClose()
            },
          },
          h('span', null, '已选文本片段 · ' + quotes.length),
        )
        var panel = null
        if (open && rect !== null) {
          var viewportWidth = window.innerWidth || 1280
          var viewportHeight = window.innerHeight || 800
          // Clamp against both edges; older code used only `rect.left`, so a
          // right-side chip in fullscreen could push the panel past the window.
          var width = Math.max(220, Math.min(420, viewportWidth - 24))
          var anchorRight = rect.right !== undefined ? rect.right : rect.left + rect.width
          var left = Math.max(12, Math.min(anchorRight - width, viewportWidth - width - 12))
          var maxHeight = Math.max(160, Math.min(420, rect.top - 24, viewportHeight - 24))
          panel = ReactDOM.createPortal(
            h(
              'div',
              {
                className: 'dsh-quote-ask-quotes-panel',
                style: { left: left + 'px', bottom: Math.max(12, viewportHeight - rect.top + 8) + 'px', width: width + 'px', maxHeight: maxHeight + 'px' },
                onMouseEnter: clearHoverCloseTimer,
                onMouseLeave: scheduleHoverClose,
              },
              h(
                'div',
                { className: 'dsh-quote-ask-quotes-head' },
                h('span', null, '已选文本片段（' + quotes.length + '）'),
                h(
                  'button',
                  { type: 'button', className: 'dsh-quote-ask-quotes-close', title: '关闭', onClick: function () { setOpen(false) } },
                  '×',
                ),
              ),
              h(
                'div',
                { className: 'dsh-quote-ask-quotes-list' },
                quoteItems.map(function (item, index) {
                  return h(
                    'div',
                    { className: 'dsh-quote-ask-quotes-item' },
                    h('span', { className: 'dsh-quote-ask-quotes-index' }, String(quoteNumberBase + index + 1)),
                    h('div', { className: 'dsh-quote-ask-quotes-text' }, item.text),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-quote-ask-quotes-remove',
                        title: isSide ? '删除这条引用（侧聊上下文同步移除）' : '删除这条引用（下一次提问不再关联）',
                        disabled: deletingIndex === index,
                        onClick: function () { deleteQuote(index) },
                      },
                      deletingIndex === index ? '…' : '×',
                    ),
                  )
                }),
              ),
              deleteError === null ? null : h('div', { className: 'dsh-quote-ask-quotes-error' }, deleteError),
              h('div', { className: 'dsh-quote-ask-quotes-hint' }, '右键选中新文字可继续添加，点 × 删除该条'),
            ),
            document.body,
          )
        }
        return h(React.Fragment, null, chip, panel)
      }
    }

    /* --------------------------------------------------------------------- *
     * Selection menu (no official context-menu slot exists in 0.2.1-rc.2, so
     * the menu is a DOM extension anchored by the product's own DOM contract:
     * `[data-chat-flow]`, `[data-conversation-content]`,
     * `[data-conversation-session]`, `[data-sidebar-right-session]`).
     * --------------------------------------------------------------------- */

    /**
     * Capture which transcript row the selection belongs to and where exactly
     * the selected characters sit inside that row's rendered text. The Host
     * embeds these facts in the model-only context so the side chat can lock the
     * exact occurrence instead of guessing.
     */
    function captureQuoteAnchor(element, range) {
      try {
        var flow = element.closest('[data-chat-flow]')
        if (flow === null) return null
        var preRange = document.createRange()
        preRange.selectNodeContents(flow)
        preRange.setEnd(range.startContainer, range.startOffset)
        var charStart = preRange.toString().length
        var selected = range.toString()
        var charEnd = charStart + selected.length
        var messageText = typeof flow.textContent === 'string' ? flow.textContent : ''
        var turn = Number(flow.getAttribute('data-chat-turn'))
        return {
          nodeKey: flow.getAttribute('data-chat-node-key') || null,
          flowKey: flow.getAttribute('data-chat-flow-key') || null,
          flowKind: flow.getAttribute('data-chat-flow-kind') || null,
          turn: Number.isSafeInteger(turn) ? turn : null,
          charStart: charStart,
          charEnd: charEnd,
          messageLength: messageText.length,
          before: messageText.slice(Math.max(0, charStart - 600), charStart),
          after: messageText.slice(charEnd, charEnd + 600),
          messageText: messageText.slice(0, 12000),
        }
      } catch {
        return null
      }
    }

    function readSelectionTarget() {
      var selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
      var rawQuote = selection.toString()
      var quote = normalizeQuote(rawQuote)
      if (quote.length === 0) return null
      var anchor = selection.anchorNode
      var element = anchor === null ? null : anchor.nodeType === 1 ? anchor : anchor.parentElement
      if (element === null || typeof element.closest !== 'function') return null
      var flow = element.closest('[data-chat-flow]')
      if (flow === null) return null
      var content = element.closest('[data-conversation-content]')
      if (content === null || !content.contains(flow)) return null
      if (content.getAttribute('data-conversation-region') !== 'chat') return null
      if (element.closest('[data-sidebar-right-session]') !== null) return null
      if (element.closest('[contenteditable="true"], input, textarea') !== null) return null
      var mainSessionId = content.getAttribute('data-conversation-session')
      if (!mainSessionId) return null
      var anchor = captureQuoteAnchor(element, selection.getRangeAt(0))
      return { quote: quote, rawQuote: rawQuote, anchor: anchor, mainSessionId: mainSessionId }
    }

    /**
     * Copy selected transcript text to the clipboard. The plugin replaces the
     * native context menu, so it must provide the Copy action itself; otherwise
     * right-clicking a selection would remove the browser's only Copy entry.
     */
    function copyTextToClipboard(text) {
      return new Promise(function (resolve, reject) {
        var value = String(text === null || text === undefined ? '' : text)
        if (value.length === 0) {
          reject(new Error('没有可复制的内容'))
          return
        }
        function fallback() {
          var area = null
          try {
            area = document.createElement('textarea')
            area.value = value
            area.setAttribute('readonly', 'readonly')
            area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;'
            document.body.appendChild(area)
            area.focus()
            area.select()
            area.setSelectionRange(0, value.length)
            var copied = false
            try {
              copied = document.execCommand('copy')
            } catch {
              copied = false
            }
            document.body.removeChild(area)
            if (copied) resolve()
            else reject(new Error('浏览器拒绝写入剪贴板'))
          } catch (error) {
            if (area !== null && area.parentElement !== null) area.parentElement.removeChild(area)
            reject(error)
          }
        }
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard
            && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(value).then(resolve, fallback)
            return
          }
        } catch {
          /* fall through to execCommand */
        }
        fallback()
      })
    }

    function makeSelectionMenu(scope) {
      return function SelectionMenuHost() {
        var menuState = React.useState(null)
        var menu = menuState[0]
        var setMenu = menuState[1]
        var toastState = React.useState(null)
        var toast = toastState[0]
        var setToast = toastState[1]

        React.useEffect(function () {
          function onContextMenu(event) {
            try {
              var target = readSelectionTarget()
              if (target === null) return
              event.preventDefault()
              var appendSideChat = findEntryForMainSession(target.mainSessionId)
              setMenu({
                x: event.clientX,
                y: event.clientY,
                quote: target.quote,
                rawQuote: target.rawQuote,
                anchor: target.anchor,
                mainSessionId: target.mainSessionId,
                appendSessionId: appendSideChat === null ? null : appendSideChat.sessionId,
                appendSideChatId: appendSideChat === null || appendSideChat.entry === null || typeof appendSideChat.entry.sideChatId !== 'string'
                  ? null
                  : appendSideChat.entry.sideChatId,
                appendQuoteCount: appendSideChat === null ? 0 : quotesOfEntry(appendSideChat.entry).length,
              })
            } catch {
              /* never let a DOM probe break the page's own context menu */
            }
          }
          document.addEventListener('contextmenu', onContextMenu, true)
          return function () {
            document.removeEventListener('contextmenu', onContextMenu, true)
          }
        }, [])

        React.useEffect(
          function () {
            if (menu === null) return undefined
            function close() {
              setMenu(null)
            }
            function onPointerDown(event) {
              // The menu is portalled to <body>, so a pointerdown on one of its
              // own buttons must NOT count as an outside click: closing here
              // would unmount the button before its click ever fires.
              var target = event.target
              if (target !== null && typeof target.closest === 'function' && target.closest('.dsh-quote-ask-menu') !== null) {
                return
              }
              close()
            }
            function onKeyDown(event) {
              if (event.key === 'Escape') close()
            }
            document.addEventListener('pointerdown', onPointerDown, true)
            document.addEventListener('scroll', close, true)
            document.addEventListener('keydown', onKeyDown, true)
            window.addEventListener('blur', close)
            window.addEventListener('resize', close)
            return function () {
              document.removeEventListener('pointerdown', onPointerDown, true)
              document.removeEventListener('scroll', close, true)
              document.removeEventListener('keydown', onKeyDown, true)
              window.removeEventListener('blur', close)
              window.removeEventListener('resize', close)
            }
          },
          [menu],
        )

        React.useEffect(
          function () {
            if (toast === null) return undefined
            var timer = window.setTimeout(function () {
              setToast(null)
            }, 6000)
            return function () {
              window.clearTimeout(timer)
            }
          },
          [toast],
        )

        function onCopy() {
          var current = menu
          setMenu(null)
          if (current === null) return
          var text = typeof current.rawQuote === 'string' && current.rawQuote.length > 0
            ? current.rawQuote
            : current.quote
          copyTextToClipboard(text).then(
            function () {
              setToast('已复制选中文字')
            },
            function (error) {
              setToast('复制失败：' + messageOf(error))
            },
          )
        }

        function onAsk() {
          var current = menu
          setMenu(null)
          if (current === null) return
          setToast('正在创建侧边聊天…')
          openSideChat(scope, current.quote, current.anchor, current.mainSessionId).then(
            function () {
              setToast(null)
            },
            function (error) {
              setToast('侧边聊天创建失败：' + messageOf(error))
            },
          )
        }

        function onAppend() {
          var current = menu
          setMenu(null)
          if (current === null || current.appendSideChatId === null || current.appendSessionId === null) return
          setToast('正在添加引用片段…')
          appendQuoteToSideChat(scope, current.appendSessionId, current.appendSideChatId, current.quote, current.anchor).then(
            function (count) {
              setToast('已添加引用片段（共 ' + count + ' 条）')
            },
            function (error) {
              setToast('添加引用片段失败：' + messageOf(error))
            },
          )
        }

        function onAddToConversation() {
          var current = menu
          setMenu(null)
          if (current === null) return
          // No success toast: the resulting quote chip is the feedback.
          addQuoteToMainConversation(scope, current.mainSessionId, current.quote, current.anchor).then(
            function () {
              /* the chip appears in the composer */
            },
            function (error) {
              setToast('添加至对话失败：' + messageOf(error))
            },
          )
        }

        var nodes = []
        if (menu !== null) {
          var hasAppend = menu.appendSideChatId !== null && menu.appendSessionId !== null
          var width = 250
          var itemCount = hasAppend ? 4 : 3
          var height = 52 + (itemCount - 1) * 44
          var viewportWidth = window.innerWidth || 1280
          var viewportHeight = window.innerHeight || 800
          var left = Math.max(8, Math.min(menu.x, viewportWidth - width - 8))
          var top = Math.max(8, Math.min(menu.y, viewportHeight - height - 8))
          nodes.push(
            ReactDOM.createPortal(
              h(
                'div',
                {
                  className: 'dsh-quote-ask-menu',
                  role: 'menu',
                  style: { left: left + 'px', top: top + 'px' },
                },
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    className: 'dsh-quote-ask-menu-item',
                    onClick: onCopy,
                  },
                  h('span', { className: 'dsh-quote-ask-menu-icon', 'aria-hidden': 'true' }, '📋'),
                  h('span', null, '复制选中文字'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    className: 'dsh-quote-ask-menu-item',
                    onClick: onAsk,
                  },
                  h('span', { className: 'dsh-quote-ask-menu-icon', 'aria-hidden': 'true' }, '💬'),
                  h('span', null, '在侧边聊天中提问'),
                ),
                hasAppend
                  ? h(
                      'button',
                      {
                        type: 'button',
                        role: 'menuitem',
                        className: 'dsh-quote-ask-menu-item',
                        onClick: onAppend,
                      },
                      h('span', { className: 'dsh-quote-ask-menu-icon', 'aria-hidden': 'true' }, '❝'),
                      h('span', null, '添加到侧边聊天引用（' + menu.appendQuoteCount + '）'),
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    className: 'dsh-quote-ask-menu-item',
                    onClick: onAddToConversation,
                  },
                  h('span', { className: 'dsh-quote-ask-menu-icon', 'aria-hidden': 'true' }, '➕'),
                  h('span', null, '添加至对话'),
                ),
              ),
              document.body,
            ),
          )
        }
        if (toast !== null) {
          nodes.push(
            ReactDOM.createPortal(
              h('div', { className: 'dsh-quote-ask-toast', role: 'status' }, toast),
              document.body,
            ),
          )
        }
        return h.apply(null, [React.Fragment, null].concat(nodes))
      }
    }

    /* --------------------------------------------------------------------- *
     * Create / open / close one side chat.
     * --------------------------------------------------------------------- */

    async function renameSideSession(scope, sessionId, title) {
      try {
        await scope.sessions.using(sessionId, { source: 'sideChat' }, async function (reference) {
          try {
            await reference.ready
          } catch {
            /* history open failed: rename is still attempted */
          }
          try {
            await reference.binding.session.rename(title)
          } catch {
            /* rename is cosmetic */
          }
        })
      } catch {
        /* the session may have been removed concurrently */
      }
    }

    async function cleanupOrQueue(scope, sideChatId, sessionId) {
      if (sideChatId || sessionId) {
        addPendingItem({ sideChatId: sideChatId || null, sessionId: sessionId || null, createdAt: Date.now() })
      }
      if (sessionId) forgetLocalSession(sessionId)
      var cleaned = await runCleanup(scope, sideChatId, sessionId)
      if (cleaned) {
        if (sessionId) {
          removeSessionEntry(sessionId)
          scheduleDraftKeyScrub(sessionId)
        }
        removePendingItem(sideChatId, sessionId)
      }
      return cleaned
    }

    async function openSideChat(scope, rawQuote, rawAnchor, mainSessionId) {
      var quote = normalizeQuote(rawQuote)
      if (quote.length === 0) throw new Error('选中内容为空')
      var sideChatId = createId()
      var prepared = await hostPost('prepare', {
        sideChatId: sideChatId,
        mainSessionId: mainSessionId,
        quote: quote,
        anchor: rawAnchor || null,
      })
      if (!prepared || typeof prepared.dir !== 'string') throw new Error('Host 没有返回侧边聊天目录')
      var sessionId = null
      try {
        sessionId = String(await scope.sessions.create({ cwd: prepared.dir }))
        // A crash between `create` and `bind` would otherwise leave a session
        // behind with no tab: remember it now so a later page load can finish
        // the cleanup. It is removed as soon as binding succeeded.
        addPendingItem({ sideChatId: sideChatId, sessionId: sessionId, phase: 'bind', createdAt: Date.now() })
        await hostPost('bind', { sideChatId: sideChatId, sessionId: sessionId })
        removePendingItem(sideChatId, null)
      } catch (error) {
        await cleanupOrQueue(scope, sideChatId, sessionId)
        throw error
      }
      var mainTitle = readMainTitle(scope, mainSessionId)
      putSessionEntry(sessionId, {
        sideChatId: sideChatId,
        sessionId: sessionId,
        mainSessionId: mainSessionId,
        mainTitle: mainTitle,
        quotes: [{ text: quote, anchor: rawAnchor || null }],
        createdAt: Date.now(),
      })
      try {
        scope.sidebarRight.openResource(addressOf(sessionId), {})
      } catch (error) {
        // The session exists but its tab could not open; delete it instead of
        // leaving an orphan behind.
        removeSessionEntry(sessionId)
        await cleanupOrQueue(scope, sideChatId, sessionId)
        throw error
      }
      void renameSideSession(scope, sessionId, mainTitle.length > 0 ? '侧聊 · ' + mainTitle : '侧聊')
    }

    /**
     * Append one main-conversation selection to the newest open side chat of
     * that conversation. The Host regenerates the model-only context file, so
     * the next turn already sees the new quote.
     * @returns {Promise<number>} total quote count after appending.
     */
    async function appendQuoteToSideChat(scope, sessionId, sideChatId, rawQuote, rawAnchor) {
      var quote = normalizeQuote(rawQuote)
      if (quote.length === 0) throw new Error('选中内容为空')
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('找不到对应的侧边聊天')
      var entry = getSessionEntry(sessionId)
      if (entry === null) throw new Error('侧边聊天不存在或已关闭')
      var items = quoteItemsOfEntry(entry)
      var alreadyQuoted = items.some(function (item) {
        if (item.text !== quote) return false
        var left = item.anchor
        var right = rawAnchor || null
        if (left === null || left === undefined || right === null) return left === right
        return left.nodeKey === right.nodeKey && left.charStart === right.charStart && left.charEnd === right.charEnd
      })
      var nextItem = { text: quote, anchor: rawAnchor || null }
      if (!alreadyQuoted) items.push(nextItem)
      // Send only the new excerpt: repeating every stored anchor here made the
      // request outgrow the Host body limit once one quoted message was long.
      var data = await hostPost('append-quote', { sideChatId: sideChatId, quote: quote, anchor: rawAnchor || null })
      entry.quotes = items
      delete entry.quote
      putSessionEntry(sessionId, entry)
      return typeof data.quoteCount === 'number' ? data.quoteCount : items.length
    }

    /**
     * Remove one quote and regenerate the model-only context. The Host deletes
     * the excerpt from context.md before returning, so the next turn cannot see
     * it any more.
     * @returns {Promise<number>} total quote count after removing.
     */
    async function removeQuoteFromSideChat(scope, sessionId, sideChatId, rawQuote, rawAnchor) {
      var quote = normalizeQuote(rawQuote)
      if (quote.length === 0) throw new Error('引用内容为空')
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('找不到对应的侧边聊天')
      var entry = getSessionEntry(sessionId)
      if (entry === null) throw new Error('侧边聊天不存在或已关闭')
      var items = quoteItemsOfEntry(entry)
      var index = items.findIndex(function (item) {
        if (item.text !== quote) return false
        var left = item.anchor
        var right = rawAnchor || null
        if (left === null || left === undefined || right === null) return left === right
        return left.nodeKey === right.nodeKey && left.charStart === right.charStart && left.charEnd === right.charEnd
      })
      if (index < 0) throw new Error('找不到该引用片段')
      var data = await hostPost('remove-quote', {
        sideChatId: sideChatId,
        quote: quote,
        anchor: rawAnchor || null,
      })
      items.splice(index, 1)
      entry.quotes = items
      delete entry.quote
      putSessionEntry(sessionId, entry)
      return typeof data.quoteCount === 'number' ? data.quoteCount : items.length
    }

    /**
     * Attach one main-conversation selection to the next turn ("添加至对话").
     * The Host stores the hidden quote state; the chip reads this local copy.
     * @returns {Promise<number>} total attached quote count.
     */
    async function addQuoteToMainConversation(scope, mainSessionId, rawQuote, rawAnchor) {
      var quote = normalizeQuote(rawQuote)
      if (quote.length === 0) throw new Error('选中内容为空')
      if (typeof mainSessionId !== 'string' || mainSessionId.length === 0) throw new Error('找不到主对话')
      var items = mainQuoteItemsForSession(mainSessionId)
      var anchor = rawAnchor || null
      var already = items.some(function (item) {
        if (item.text !== quote) return false
        if (item.anchor === null || anchor === null) return item.anchor === anchor
        return item.anchor.nodeKey === anchor.nodeKey
          && item.anchor.charStart === anchor.charStart
          && item.anchor.charEnd === anchor.charEnd
      })
      var data = await hostPost('attach-main-quote', {
        mainSessionId: mainSessionId,
        quote: quote,
        anchor: anchor,
      })
      if (!already) items.push({ text: quote, anchor: anchor })
      setMainQuoteItemsForSession(mainSessionId, items)
      return typeof data.quoteCount === 'number' ? data.quoteCount : items.length
    }

    /** Remove one attached quote from the main conversation and its next-turn context. */
    async function removeMainQuoteFromConversation(scope, mainSessionId, rawQuote, rawAnchor) {
      var quote = normalizeQuote(rawQuote)
      if (quote.length === 0) throw new Error('引用内容为空')
      if (typeof mainSessionId !== 'string' || mainSessionId.length === 0) throw new Error('找不到主对话')
      var items = mainQuoteItemsForSession(mainSessionId)
      var anchor = rawAnchor || null
      var index = items.findIndex(function (item) {
        if (item.text !== quote) return false
        if (item.anchor === null || anchor === null) return item.anchor === anchor
        return item.anchor.nodeKey === anchor.nodeKey
          && item.anchor.charStart === anchor.charStart
          && item.anchor.charEnd === anchor.charEnd
      })
      if (index < 0) throw new Error('找不到该引用片段')
      var data = await hostPost('remove-main-quote', {
        mainSessionId: mainSessionId,
        quote: quote,
        anchor: anchor,
      })
      items.splice(index, 1)
      setMainQuoteItemsForSession(mainSessionId, items)
      return typeof data.quoteCount === 'number' ? data.quoteCount : items.length
    }

    /** Host is authoritative after a turn consumes/clears attached quotes. */
    async function refreshMainQuotesFromHost(scope, mainSessionId) {
      if (typeof mainSessionId !== 'string' || mainSessionId.length === 0) return
      try {
        var data = await hostPost('main-quotes-list', { mainSessionId: mainSessionId })
        if (data === null || typeof data !== 'object' || !Array.isArray(data.quotes)) return
        setMainQuoteItemsForSession(mainSessionId, normalizeMainQuoteItems(data.quotes))
      } catch {
        /* chip sync is best effort */
      }
    }

    /* --------------------------------------------------------------------- *
     * Transcript highlight: a live quote leaves a coloured highlight and a
     * numbered badge on the exact excerpt in its source (main) conversation.
     *
     * Design constraints, learned from DSH's streaming transcript:
     *   - The background is painted with the browser's CSS Custom Highlight
     *     API (`CSS.highlights`), so the transcript DOM is never mutated and a
     *     React re-render cannot wipe the annotation.
     *   - Ranges are re-derived from the quote's stored anchor on every
     *     structural change. Older anchors are relative to whichever
     *     `[data-chat-flow]` contained the selection, so every candidate flow
     *     is tried until the recorded text matches at the recorded offsets.
     *     If the transcript shifted (pagination/streaming), the recorded
     *     before/after text and finally the excerpt itself are used.
     *   - The number badge lives in a fixed overlay (never inside the
     *     transcript) and is repositioned on scroll/resize.
     *   - Only quotes attached to the conversation currently on screen are
     *     drawn. Removing a quote (chip ×, consumed turn, closed side chat)
     *     removes its highlight on the next sync.
     * --------------------------------------------------------------------- */

    /** Whether this browser can paint ranges without touching the DOM. */
    function highlightSupported() {
      try {
        return typeof window !== 'undefined'
          && typeof window.CSS === 'object' && window.CSS !== null
          && typeof window.CSS.highlights === 'object' && window.CSS.highlights !== null
          && typeof window.Highlight === 'function'
      } catch {
        return false
      }
    }

    /** Newest side chat last: used for both badge numbering and chip offsets. */
    function compareSideEntries(left, right) {
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
      if (left.sessionId === right.sessionId) return 0
      return left.sessionId < right.sessionId ? -1 : 1
    }

    /** All open side chats of one main conversation, in a stable order. */
    function sideEntriesForMain(mainSessionId) {
      if (typeof mainSessionId !== 'string' || mainSessionId.length === 0) return []
      var entries = readSessionEntries()
      var list = []
      for (var sessionId of Object.keys(entries)) {
        var entry = entries[sessionId]
        if (entry === null || typeof entry !== 'object') continue
        if (entry.mainSessionId !== mainSessionId) continue
        var createdAt = Number(entry.createdAt)
        if (!Number.isFinite(createdAt)) createdAt = 0
        list.push({ sessionId: sessionId, entry: entry, createdAt: createdAt })
      }
      list.sort(compareSideEntries)
      return list
    }

    /**
     * Number offset for a side chat's chip panel. Main-conversation quotes come
     * first, then side chats in `sideEntriesForMain` order; this keeps the
     * number on a badge identical to the number in the panel that owns it.
     */
    function sideQuoteNumberOffset(entry) {
      if (entry === null || typeof entry !== 'object') return 0
      var mainSessionId = entry.mainSessionId
      var offset = mainQuoteItemsForSession(mainSessionId).length
      for (var side of sideEntriesForMain(mainSessionId)) {
        if (side.sessionId === entry.sessionId) break
        offset += quoteItemsOfEntry(side.entry).length
      }
      return offset
    }

    /**
     * Every quote that should currently be visible in one main conversation,
     * with its stable number. Main attachments are 1..n; each open side chat
     * continues the sequence so two badges never share a number.
     */
    function activeQuoteListForMain(mainSessionId) {
      var list = []
      var mainItems = mainQuoteItemsForSession(mainSessionId)
      for (var index = 0; index < mainItems.length; index += 1) {
        list.push({
          text: mainItems[index].text,
          anchor: mainItems[index].anchor,
          number: list.length + 1,
          source: 'main',
        })
      }
      for (var side of sideEntriesForMain(mainSessionId)) {
        var items = quoteItemsOfEntry(side.entry)
        for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          list.push({
            text: items[itemIndex].text,
            anchor: items[itemIndex].anchor,
            number: list.length + 1,
            source: 'side',
            sideSessionId: side.sessionId,
          })
        }
      }
      return list
    }

    /** The main conversation currently laid out on screen, or null. */
    function activeChatContent() {
      try {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
        var nodes = document.querySelectorAll('[data-conversation-content][data-conversation-region="chat"]')
        var fallback = null
        for (var index = 0; index < nodes.length; index += 1) {
          var content = nodes[index]
          if (typeof content.closest === 'function' && content.closest('[data-sidebar-right-session]') !== null) continue
          var sessionId = content.getAttribute('data-conversation-session')
          if (!sessionId) continue
          var candidate = { element: content, sessionId: sessionId }
          if (typeof content.getClientRects === 'function' && content.getClientRects().length > 0) return candidate
          if (fallback === null) fallback = candidate
        }
        return fallback
      } catch {
        return null
      }
    }

    /**
     * Candidate roots for resolving one anchor. Exact node/flow keys go first;
     * then every transcript flow (the outer column and group bodies); then the
     * per-message rows, which are the most specific roots when an anchor uses
     * them.
     */
    function candidateFlows(content, anchor) {
      var list = []
      var seen = []
      function push(element) {
        if (element === null || element === undefined) return
        if (seen.indexOf(element) >= 0) return
        seen.push(element)
        list.push(element)
      }
      try {
        if (anchor !== null && typeof anchor === 'object') {
          if (typeof anchor.nodeKey === 'string' && anchor.nodeKey.length > 0) {
            var nodes = content.querySelectorAll('[data-chat-node-key]')
            for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
              if (nodes[nodeIndex].getAttribute('data-chat-node-key') === anchor.nodeKey) push(nodes[nodeIndex])
            }
          }
          if (typeof anchor.flowKey === 'string' && anchor.flowKey.length > 0) {
            var flows = content.querySelectorAll('[data-chat-flow-key]')
            for (var flowIndex = 0; flowIndex < flows.length; flowIndex += 1) {
              if (flows[flowIndex].getAttribute('data-chat-flow-key') === anchor.flowKey) push(flows[flowIndex])
            }
          }
        }
        var containers = content.querySelectorAll('[data-chat-flow]')
        for (var containerIndex = 0; containerIndex < containers.length; containerIndex += 1) push(containers[containerIndex])
        var rows = content.querySelectorAll('[data-chat-flow-key]')
        for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) push(rows[rowIndex])
        push(content)
      } catch {
        /* a malformed tree only means no candidate */
      }
      return list
    }

    /**
     * Map a character span of `root.textContent` back to a DOM Range. Returns
     * null when the span no longer holds the expected excerpt.
     */
    function rangeForOffsets(root, start, end, quoteText) {
      try {
        if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return null
        if (typeof NodeFilter === 'undefined') return null
        var body = typeof root.textContent === 'string' ? root.textContent : ''
        if (!Number.isInteger(start) || !Number.isInteger(end)) return null
        if (start < 0 || end <= start || end > body.length) return null
        var expected = normalizeQuote(quoteText)
        if (expected.length === 0) return null
        if (normalizeQuote(body.slice(start, end)) !== expected) return null
        while (start < end && /\s/.test(body.charAt(start))) start += 1
        while (end > start && /\s/.test(body.charAt(end - 1))) end -= 1
        if (end <= start) return null
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
        var nodes = []
        var starts = []
        var total = 0
        var node = walker.nextNode()
        while (node !== null) {
          var value = typeof node.nodeValue === 'string' ? node.nodeValue : ''
          if (value.length > 0) {
            nodes.push(node)
            starts.push(total)
            total += value.length
          }
          node = walker.nextNode()
        }
        if (nodes.length === 0 || start >= total) return null
        var startNode = -1
        var endNode = -1
        for (var index = 0; index < nodes.length; index += 1) {
          var length = nodes[index].nodeValue.length
          if (startNode < 0 && start < starts[index] + length) startNode = index
          if (endNode < 0 && end <= starts[index] + length) endNode = index
          if (startNode >= 0 && endNode >= 0) break
        }
        if (startNode < 0) startNode = nodes.length - 1
        if (endNode < 0) endNode = nodes.length - 1
        var range = document.createRange()
        range.setStart(nodes[startNode], Math.max(0, Math.min(start - starts[startNode], nodes[startNode].nodeValue.length)))
        range.setEnd(nodes[endNode], Math.max(0, Math.min(end - starts[endNode], nodes[endNode].nodeValue.length)))
        if (range.collapsed) return null
        if (normalizeQuote(range.toString()) !== expected) return null
        return range
      } catch {
        return null
      }
    }

    /** Find one plain excerpt inside a flow, splitting multi-line quotes. */
    function rangesForText(flow, quoteText) {
      var body = typeof flow.textContent === 'string' ? flow.textContent : ''
      var at = body.indexOf(quoteText)
      if (at >= 0) {
        var hit = rangeForOffsets(flow, at, at + quoteText.length, quoteText)
        if (hit !== null) return [hit]
      }
      var lines = quoteText.split(/\r\n?|\n/).map(function (line) {
        return line.trim()
      }).filter(function (line) {
        return line.length > 0
      })
      if (lines.length <= 1) return []
      var ranges = []
      for (var index = 0; index < lines.length; index += 1) {
        var lineAt = body.indexOf(lines[index])
        if (lineAt < 0) continue
        var lineRange = rangeForOffsets(flow, lineAt, lineAt + lines[index].length, lines[index])
        if (lineRange !== null) ranges.push(lineRange)
      }
      return ranges
    }

    /**
     * Resolve a quote to one or more ranges. Uses, in order: exact recorded
     * offsets, the recorded before/after window, then the excerpt text.
     */
    function resolveQuoteRanges(content, item) {
      var quoteText = normalizeQuote(item.text)
      if (quoteText.length === 0) return []
      var anchor = item.anchor !== null && typeof item.anchor === 'object' ? item.anchor : null
      var flows = candidateFlows(content, anchor)
      if (flows.length === 0) return []

      if (anchor !== null && Number.isInteger(anchor.charStart) && Number.isInteger(anchor.charEnd)) {
        for (var exactIndex = 0; exactIndex < flows.length; exactIndex += 1) {
          var exact = rangeForOffsets(flows[exactIndex], anchor.charStart, anchor.charEnd, quoteText)
          if (exact !== null) return [exact]
        }
      }

      if (anchor !== null) {
        var before = typeof anchor.before === 'string' ? anchor.before : ''
        var after = typeof anchor.after === 'string' ? anchor.after : ''
        var beforeTail = before.slice(-80)
        var afterHead = after.slice(0, 80)
        for (var windowIndex = 0; windowIndex < flows.length; windowIndex += 1) {
          var flow = flows[windowIndex]
          var body = typeof flow.textContent === 'string' ? flow.textContent : ''
          var at = body.indexOf(beforeTail + quoteText + afterHead)
          if (at >= 0) {
            var windowRange = rangeForOffsets(flow, at + beforeTail.length, at + beforeTail.length + quoteText.length, quoteText)
            if (windowRange !== null) return [windowRange]
          }
          if (beforeTail.length > 0) {
            at = body.lastIndexOf(beforeTail + quoteText)
            if (at >= 0) {
              var tailRange = rangeForOffsets(flow, at + beforeTail.length, at + beforeTail.length + quoteText.length, quoteText)
              if (tailRange !== null) return [tailRange]
            }
          }
          at = body.indexOf(quoteText)
          if (at >= 0) {
            var plainRange = rangeForOffsets(flow, at, at + quoteText.length, quoteText)
            if (plainRange !== null) return [plainRange]
          }
        }
      }

      for (var textIndex = 0; textIndex < flows.length; textIndex += 1) {
        var ranges = rangesForText(flows[textIndex], quoteText)
        if (ranges.length > 0) return ranges
      }
      return []
    }

    /** Stable fingerprint of the visible quote set, used to avoid re-resolving. */
    function quoteSignature(list) {
      var parts = []
      for (var index = 0; index < list.length; index += 1) {
        var item = list[index]
        var anchor = item.anchor !== null && typeof item.anchor === 'object' ? item.anchor : {}
        parts.push([
          item.number,
          item.source,
          anchor.nodeKey === undefined || anchor.nodeKey === null ? '' : anchor.nodeKey,
          anchor.flowKey === undefined || anchor.flowKey === null ? '' : anchor.flowKey,
          anchor.charStart === undefined || anchor.charStart === null ? '' : anchor.charStart,
          anchor.charEnd === undefined || anchor.charEnd === null ? '' : anchor.charEnd,
          item.text,
        ].join('\u0002'))
      }
      return parts.join('\u0001')
    }

    /** Rebuild highlight + badges from the live quote set, then follow layout. */
    function installTranscriptHighlight(scope) {
      scope.effect(function () {
        if (!highlightSupported()) return function () {}
        var state = {
          content: null,
          sessionId: null,
          signature: null,
          entries: [],
          ranges: [],
          badges: [],
          layer: null,
          frame: 0,
          force: false,
          unresolved: 0,
          missedAt: 0,
          retryTimer: 0,
          resizeObserver: null,
          observedContent: null,
        }
        var observer = null

        function clearAll() {
          state.content = null
          state.sessionId = null
          state.signature = null
          state.entries = []
          state.ranges = []
          state.badges = []
          state.unresolved = 0
          state.missedAt = 0
          if (state.resizeObserver !== null) {
            try {
              state.resizeObserver.disconnect()
            } catch {
              /* already gone */
            }
            state.resizeObserver = null
          }
          state.observedContent = null
          if (state.retryTimer !== 0) {
            try {
              window.clearTimeout(state.retryTimer)
            } catch {
              /* already gone */
            }
            state.retryTimer = 0
          }
          try {
            window.CSS.highlights.delete(HIGHLIGHT_NAME)
          } catch {
            /* already gone */
          }
          if (state.layer !== null) {
            while (state.layer.firstChild) state.layer.removeChild(state.layer.firstChild)
          }
        }

        function allRangesValid() {
          for (var entryIndex = 0; entryIndex < state.entries.length; entryIndex += 1) {
            var entry = state.entries[entryIndex]
            for (var rangeIndex = 0; rangeIndex < entry.ranges.length; rangeIndex += 1) {
              var range = entry.ranges[rangeIndex]
              try {
                if (!range.startContainer || range.startContainer.isConnected === false) return false
                if (normalizeQuote(range.toString()) !== entry.text) return false
              } catch {
                return false
              }
            }
          }
          return true
        }

        function ensureLayer() {
          if (state.layer !== null && state.layer.isConnected) return state.layer
          if (typeof document === 'undefined' || document.body === null || typeof document.body.appendChild !== 'function') return null
          var layer = document.createElement('div')
          layer.setAttribute(BADGE_LAYER_ATTR, '')
          layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483000;'
          document.body.appendChild(layer)
          state.layer = layer
          return layer
        }

        /**
         * The composer grows while the user types, which shrinks the transcript
         * viewport without a scroll or window resize event. Re-position badges
         * when the transcript box changes size.
         */
        function bindResizeObserver(content) {
          if (typeof ResizeObserver !== 'function') return
          if (state.resizeObserver === null) {
            state.resizeObserver = new ResizeObserver(function () {
              schedule(false)
            })
          }
          state.resizeObserver.disconnect()
          try {
            state.resizeObserver.observe(content)
            var scroller = typeof content.closest === 'function' ? content.closest('[data-conversation-scroll]') : null
            if (scroller !== null) state.resizeObserver.observe(scroller)
            var seat = content.querySelector('[data-composer-seat]')
            if (seat !== null) state.resizeObserver.observe(seat)
          } catch {
            /* sizing is best effort */
          }
        }

        function endRectOf(ranges) {
          for (var rangeIndex = ranges.length - 1; rangeIndex >= 0; rangeIndex -= 1) {
            var range = ranges[rangeIndex]
            try {
              var rects = range.getClientRects()
              for (var rectIndex = rects.length - 1; rectIndex >= 0; rectIndex -= 1) {
                if (rects[rectIndex].width > 0 && rects[rectIndex].height > 0) return rects[rectIndex]
              }
              var box = range.getBoundingClientRect()
              if (box.width > 0 || box.height > 0) return box
            } catch {
              /* detached range: try the previous one */
            }
          }
          return null
        }

        function positionBadges() {
          if (state.content === null || state.badges.length === 0) return
          var scroller = typeof state.content.closest === 'function'
            ? state.content.closest('[data-conversation-scroll]')
            : null
          if (scroller === null) scroller = state.content
          var box = null
          try {
            box = scroller.getBoundingClientRect()
          } catch {
            box = null
          }
          if (box === null) return
          var viewportWidth = window.innerWidth || 1280
          // The composer is sticky at the bottom of the same scroll body. Text
          // scrolled behind it is not visible, so neither is its badge.
          var bottom = box.bottom
          try {
            var seat = state.content.querySelector('[data-composer-seat]')
            if (seat !== null) {
              var seatRect = seat.getBoundingClientRect()
              if (seatRect.top > box.top + 1 && seatRect.top < bottom) bottom = seatRect.top
            }
          } catch {
            /* keep the scroll box as the clip */
          }
          var placed = []
          for (var index = 0; index < state.badges.length; index += 1) {
            var badge = state.badges[index]
            var rect = endRectOf(badge.ranges)
            if (rect === null) {
              badge.element.style.visibility = 'hidden'
              continue
            }
            var visible = rect.bottom >= box.top && rect.top <= bottom
              && rect.right >= box.left && rect.left <= box.right
            if (!visible) {
              badge.element.style.visibility = 'hidden'
              continue
            }
            var left = Math.round(rect.right - 4)
            var top = Math.round(rect.top - 8)
            left = Math.max(Math.max(2, box.left + 2), Math.min(left, Math.min(box.right - 18, viewportWidth - 18)))
            top = Math.max(Math.max(2, box.top + 2), Math.min(top, bottom - 17))
            // Two quotes can share one excerpt (main attachment + side chat).
            // Stack their badges instead of painting the numbers on top of each
            // other.
            for (var attempt = 0; attempt < 4; attempt += 1) {
              var collides = false
              for (var placedIndex = 0; placedIndex < placed.length; placedIndex += 1) {
                if (Math.abs(placed[placedIndex].left - left) < 14
                  && Math.abs(placed[placedIndex].top - top) < 14) {
                  collides = true
                  break
                }
              }
              if (!collides) break
              top = Math.min(bottom - 17, top + 16)
            }
            placed.push({ left: left, top: top })
            badge.element.style.left = left + 'px'
            badge.element.style.top = top + 'px'
            badge.element.style.visibility = 'visible'
          }
        }

        function rebuildBadges() {
          var layer = ensureLayer()
          if (layer === null) return
          while (layer.firstChild) layer.removeChild(layer.firstChild)
          state.badges = []
          for (var index = 0; index < state.entries.length; index += 1) {
            var entry = state.entries[index]
            var badge = document.createElement('span')
            badge.className = 'dsh-quote-ask-badge'
            badge.setAttribute('aria-hidden', 'true')
            badge.textContent = String(entry.number)
            layer.appendChild(badge)
            state.badges.push({ element: badge, ranges: entry.ranges })
          }
          positionBadges()
        }

        function applyHighlight(ranges) {
          try {
            if (ranges.length === 0) {
              window.CSS.highlights.delete(HIGHLIGHT_NAME)
              return
            }
            var highlight = new window.Highlight()
            for (var index = 0; index < ranges.length; index += 1) highlight.add(ranges[index])
            window.CSS.highlights.set(HIGHLIGHT_NAME, highlight)
          } catch {
            /* annotation is additive: never break quoting */
          }
        }

        function sync(force) {
          try {
            var active = activeChatContent()
            if (active === null) {
              clearAll()
              return
            }
            var list = activeQuoteListForMain(active.sessionId)
            var signature = quoteSignature(list)
            // A quote whose message is currently unmounted (virtualized or
            // collapsed) is retried at most twice a second instead of on every
            // streaming frame; a forced sync still retries immediately.
            var retryUnresolved = state.unresolved > 0 && Date.now() - state.missedAt > 500
            var needsResolve = force
              || state.content !== active.element
              || state.sessionId !== active.sessionId
              || state.signature !== signature
              || !allRangesValid()
              || retryUnresolved
            if (needsResolve) {
              state.content = active.element
              if (state.observedContent !== active.element) {
                state.observedContent = active.element
                bindResizeObserver(active.element)
              }
              state.sessionId = active.sessionId
              state.signature = signature
              state.entries = []
              var ranges = []
              for (var index = 0; index < list.length; index += 1) {
                var resolved = resolveQuoteRanges(active.element, list[index])
                if (resolved.length === 0) continue
                state.entries.push({ number: list[index].number, text: normalizeQuote(list[index].text), ranges: resolved })
                for (var rangeIndex = 0; rangeIndex < resolved.length; rangeIndex += 1) ranges.push(resolved[rangeIndex])
              }
              state.ranges = ranges
              state.unresolved = list.length - state.entries.length
              if (state.unresolved > 0) {
                state.missedAt = Date.now()
                // A virtualized/collapsed row may mount without producing a
                // mutation we can see; keep one lightweight retry pending.
                if (state.retryTimer === 0 && typeof window.setTimeout === 'function') {
                  state.retryTimer = window.setTimeout(function () {
                    state.retryTimer = 0
                    schedule(true)
                  }, 700)
                }
              } else if (state.retryTimer !== 0) {
                window.clearTimeout(state.retryTimer)
                state.retryTimer = 0
              }
              applyHighlight(ranges)
              rebuildBadges()
            }
            positionBadges()
          } catch {
            /* the transcript is best-effort decoration */
          }
        }

        function schedule(force) {
          if (force) state.force = true
          if (state.frame !== 0) return
          if (typeof window.requestAnimationFrame !== 'function') {
            var immediate = state.force
            state.force = false
            sync(immediate)
            return
          }
          state.frame = window.requestAnimationFrame(function () {
            state.frame = 0
            var forced = state.force
            state.force = false
            sync(forced)
          })
        }

        function onScroll() {
          schedule(false)
        }

        function onResize() {
          schedule(false)
        }

        var off = subscribeEntriesChanged(function () {
          schedule(true)
        })
        try {
          if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body) {
            observer = new MutationObserver(function () {
              schedule(false)
            })
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
              attributes: true,
              attributeFilter: ['data-conversation-session', 'data-conversation-region'],
            })
          }
        } catch {
          observer = null
        }
        try {
          window.addEventListener('scroll', onScroll, true)
          window.addEventListener('resize', onResize)
        } catch {
          /* listeners are best effort */
        }
        schedule(true)

        return function () {
          try {
            off()
          } catch {
            /* already detached */
          }
          if (observer !== null) {
            try {
              observer.disconnect()
            } catch {
              /* already disconnected */
            }
          }
          try {
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', onResize)
          } catch {
            /* listeners are best effort */
          }
          if (state.frame !== 0 && typeof window.cancelAnimationFrame === 'function') {
            try {
              window.cancelAnimationFrame(state.frame)
            } catch {
              /* already gone */
            }
          }
          if (state.retryTimer !== 0) {
            try {
              window.clearTimeout(state.retryTimer)
            } catch {
              /* already gone */
            }
            state.retryTimer = 0
          }
          state.frame = 0
          clearAll()
          if (state.layer !== null && state.layer.parentElement) {
            try {
              state.layer.parentElement.removeChild(state.layer)
            } catch {
              /* document teardown */
            }
          }
          state.layer = null
        }
      }, 'quote-ask: transcript highlight')
    }

    async function cancelSideSession(scope, sessionId) {
      try {
        await scope.sessions.using(sessionId, { source: 'sideChat' }, async function (reference) {
          try {
            await reference.ready
          } catch {
            /* no live generation: nothing to cancel */
          }
          try {
            await reference.binding.session.cancel()
          } catch {
            /* already idle */
          }
        })
      } catch {
        /* session already gone */
      }
    }

    async function runCleanup(scope, sideChatId, sessionId) {
      var data = null
      try {
        data = await hostPost('cleanup', {
          sideChatId: sideChatId || undefined,
          sessionId: sessionId || undefined,
        })
      } catch {
        return false
      }
      try {
        await scope.sessions.refresh()
      } catch {
        /* the deleted session disappearing from the list is cosmetic */
      }
      // The Host reports artifacts it could not prove/remove in `failed`; keep
      // the retry entry until a pass has nothing left to do.
      var failed = data !== null && Array.isArray(data.failed) ? data.failed : []
      return failed.length === 0
    }

    async function cancelAndCleanup(scope, sessionId, sideChatId) {
      await cancelSideSession(scope, sessionId)
      // Let the Host finish the cancellation and any persistence drain before
      // deleting the session's files. A failure at this point is retried by the
      // Host startup sweep and by the client retry queue.
      await sleep(800)
      addPendingItem({ sideChatId: sideChatId, sessionId: sessionId, createdAt: Date.now() })
      // The session is gone from the user's point of view; do not leave DSH's
      // per-session draft (which holds the quoted excerpt) in localStorage.
      forgetLocalSession(sessionId)
      var cleaned = await runCleanup(scope, sideChatId, sessionId)
      if (cleaned) {
        removeSessionEntry(sessionId)
        removePendingItem(sideChatId, sessionId)
        scheduleDraftKeyScrub(sessionId)
      }
    }

    async function retryPendingCleanups(scope) {
      var list = readPendingList()
      for (var index = 0; index < list.length; index += 1) {
        var item = list[index]
        var sideChatId = typeof item.sideChatId === 'string' ? item.sideChatId : null
        var sessionId = typeof item.sessionId === 'string' ? item.sessionId : null
        if (sideChatId === null && sessionId === null) continue
        // These side chats were already closed; scrub their client-side draft
        // state even when the Host cleanup still has retries to do.
        if (sessionId !== null) forgetLocalSession(sessionId)
        var cleaned = await runCleanup(scope, sideChatId, sessionId)
        if (cleaned) {
          if (sessionId !== null) {
            removeSessionEntry(sessionId)
            scheduleDraftKeyScrub(sessionId)
          }
          removePendingItem(sideChatId, sessionId)
        }
      }
    }

    /* --------------------------------------------------------------------- *
     * Styles. Only DSH theme tokens, never literals for surfaces/text, so the
     * menu follows the active light/dark theme.
     * --------------------------------------------------------------------- */

    var CSS = [
      '.dsh-quote-ask-tab{display:flex;flex-direction:column;align-items:stretch;flex:1 1 auto;width:100%;min-width:0;height:100%;min-height:calc(100vh - 112px);overflow:hidden}',
      '.dsh-quote-ask-conversation{display:flex;flex-direction:column;align-items:stretch;flex:1 1 auto;width:100%;min-width:0;min-height:0;overflow:hidden}',
      '.dsh-quote-ask-conversation > *{display:flex;flex-direction:column;align-items:stretch;flex:1 1 auto;width:100%;min-width:0;min-height:0}',
      '.dsh-quote-ask-tab [data-content-phase="hero"] [data-conversation-scroll],.dsh-quote-ask-tab [data-content-phase="blank"] [data-conversation-scroll]{justify-content:flex-end}',
      '.dsh-quote-ask-tab [data-composer-seat]{margin-top:auto !important;flex:none}',
      '.dsh-quote-ask-message{padding:16px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary,#6b6f76)}',
      '.dsh-quote-ask-quote-chip{display:inline-flex;align-items:center;gap:5px;max-width:230px;height:28px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:999px;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,#5f6368);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-quote-ask-quote-chip:hover,.dsh-quote-ask-quote-chip-open{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328)}',
      '.dsh-quote-ask-quotes-panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;min-height:0;padding:10px 12px;border-radius:14px;background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-overlay,#232326));border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.28));color:var(--dsw-alias-label-primary,#f5f5f5);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);font-size:12.5px;line-height:1.6;-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-sizing:border-box;max-width:calc(100vw - 24px)}',
      '.dsh-quote-ask-quotes-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600;font-size:12.5px;padding-bottom:6px;border-bottom:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}',
      '.dsh-quote-ask-quotes-close{border:0;background:none;color:var(--dsw-alias-label-secondary,#8b9096);font-size:18px;line-height:18px;cursor:pointer;padding:0 2px}',
      '.dsh-quote-ask-quotes-list{display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:0;padding:8px 2px 4px}',
      '.dsh-quote-ask-quotes-item{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08))}',
      '.dsh-quote-ask-quotes-index{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3b82f6);color:#fff;font-size:11px;line-height:1;margin-top:2px}',
      '.dsh-quote-ask-quotes-text{flex:1 1 auto;min-width:0;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#c9cdd3);max-height:9em;overflow:auto}',
      '.dsh-quote-ask-quotes-remove{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b9096);font:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0 2px;border-radius:6px}',
      '.dsh-quote-ask-quotes-remove:hover,.dsh-quote-ask-quotes-remove:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#f5f5f5);outline:none}',
      '.dsh-quote-ask-quotes-remove:disabled{opacity:.5;cursor:default}',
      '.dsh-quote-ask-quotes-error{font-size:11.5px;color:var(--dsw-alias-state-danger-primary,#f87171);padding-top:4px}',
      '.dsh-quote-ask-quotes-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b9096);padding-top:6px}',
      '::highlight(dsh-quote-ask){background-color:rgba(255,224,0,.55);color:inherit}',
      '@media (prefers-color-scheme: dark){::highlight(dsh-quote-ask){background-color:rgba(255,224,0,.32)}}',
      '.dsh-quote-ask-badge{position:fixed;z-index:2147483000;pointer-events:none;min-width:15px;height:15px;padding:0 4px;box-sizing:border-box;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);font-size:10px;line-height:15px;text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 1px 3px rgba(15,17,21,.18);-webkit-user-select:none;user-select:none}',
      '.dsh-quote-ask-menu{position:fixed;z-index:2147483000;min-width:200px;padding:4px;border-radius:12px;background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-overlay,#232326));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.28));border:0.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);font-size:13px;line-height:20px}',
      '.dsh-quote-ask-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#f5f5f5);font:inherit;text-align:left;cursor:pointer;line-height:20px}',
      '.dsh-quote-ask-menu-item:hover,.dsh-quote-ask-menu-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));outline:none}',
      '.dsh-quote-ask-menu-icon{display:inline-flex;width:16px;justify-content:center;align-items:center;opacity:.9}',
      '.dsh-quote-ask-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483000;max-width:min(520px,calc(100vw - 48px));padding:9px 14px;border-radius:10px;background:var(--dsw-alias-bg-overlay,#2a2a2e);color:var(--dsw-alias-label-primary,#f5f5f5);box-shadow:var(--dsw-elevation-panel,0 6px 20px rgba(0,0,0,.3));font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);font-size:13px;line-height:20px}',
    ].join('\n')

    function installStyles(scope) {
      scope.effect(
        function () {
          var style = document.createElement('style')
          style.dataset.plugin = TAB_ID
          style.textContent = CSS
          document.head.appendChild(style)
          return function () {
            try {
              style.remove()
            } catch {
              /* the document may be tearing down */
            }
          }
        },
        'quote-ask: styles',
      )
    }

    /* --------------------------------------------------------------------- *
     * Registration.
     * --------------------------------------------------------------------- */

    function installResourceProvider(scope) {
      scope.effect(
        function () {
          return scope.resources.register({
            protocol: PROTOCOL,
            open: async function* openResource(address, openContext) {
              var sessionId = parseAddress(address)
              if (sessionId === null) {
                yield { ok: false, error: { code: 'invalid-address', message: 'dsh-quote-ask: invalid resource address' } }
                return
              }
              if (openContext.signal.aborted) return
              var reference = null
              try {
                reference = scope.sessions.retain(sessionId, { source: 'sideChat', signal: openContext.signal })
              } catch (error) {
                yield { ok: false, error: { code: 'retain-failed', message: messageOf(error) } }
                return
              }
              try {
                // Wait for the retained generation's initial open before handing
                // it to SessionProvider. A side chat whose session has already
                // been cleaned up must surface as a resource failure instead of a
                // half-open reference, and the recovery path for a restored tab
                // needs the failure frame to be reachable.
                var ready = await Promise.race([
                  Promise.resolve(reference.ready).then(
                    function () { return { ok: true } },
                    function (error) { return { ok: false, error: error } },
                  ),
                  new Promise(function (resolve) {
                    if (openContext.signal.aborted) {
                      resolve({ ok: false, aborted: true })
                      return
                    }
                    openContext.signal.addEventListener('abort', function () { resolve({ ok: false, aborted: true }) }, { once: true })
                  }),
                ])
                if (ready.ok !== true) {
                  if (ready.aborted !== true) {
                    yield {
                      ok: false,
                      error: { code: 'session-unavailable', message: messageOf(ready.error) },
                    }
                  }
                  return
                }
                // Activity heartbeat: an open side chat whose layout was lost
                // (crash, cleared localStorage) is reaped by the Host only after
                // a long idle window.
                try {
                  var entry = getSessionEntry(sessionId)
                  if (entry !== null && typeof entry.sideChatId === 'string') {
                    hostPost('touch', { sideChatId: entry.sideChatId }).catch(function () {})
                  }
                } catch {
                  /* the heartbeat is best-effort */
                }
                yield {
                  ok: true,
                  value: { sessionId: sessionId, reference: reference },
                }
                await new Promise(function (resolve) {
                  if (openContext.signal.aborted) {
                    resolve()
                    return
                  }
                  openContext.signal.addEventListener('abort', function () { resolve() }, { once: true })
                })
              } finally {
                try {
                  reference.release()
                } catch {
                  /* already released */
                }
              }
            },
          })
        },
        'quote-ask: resource provider',
      )
    }

    function installTabType(scope) {
      scope.effect(
        function () {
          return scope.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            patterns: [ADDRESS_PREFIX + '**'],
            priority: 'extension',
            title: titleForAddress,
          })
        },
        'quote-ask: tab type',
      )
    }

    function installTabBody(scope) {
      scope.slots.inject('sidebar.right.pane.tab', function () {
        return scope.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            children: { [CONVERSATION_SLOT]: { kind: 'single', scope: 'session' } },
          },
          makeTabBody(),
        )
      })
    }

    function installConversationSlot(scope) {
      scope.slots.inject(CONVERSATION_SLOT, function () {
        return scope.slots.register({ name: CONVERSATION_SLOT }, makeConversationPanel())
      })
    }

    function installCloseHandler(scope) {
      scope.effect(
        function () {
          return scope.sidebarRight.registerCloseHandler(TAB_KIND, function (mainSessionId, tab) {
            try {
              if (!tab || tab.kind !== TAB_KIND) return
              var sessionId = parseAddress(tab.contentId)
              if (sessionId === null) return
              var entry = getSessionEntry(sessionId)
              var sideChatId = entry !== null && typeof entry.sideChatId === 'string' ? entry.sideChatId : null
              void cancelAndCleanup(scope, sessionId, sideChatId)
            } catch {
              /* a malformed tab must never break the sidebar */
            }
          })
        },
        'quote-ask: close handler',
      )
    }

    function installQuoteChip(scope) {
      scope.slots.inject('conversation.input.left', function () {
        return scope.slots.register(
          {
            name: 'conversation.input.left',
            id: 'dsh-quote-ask-quotes',
            order: 10,
            inject: function (sessionId) {
              return { sessionId: sessionId }
            },
          },
          makeQuoteChip(scope),
        )
      })
    }

    /**
     * Side-chat sessions must not show up in the left conversation list. The
     * DSH archive feature would hide them but also blocks every model step of an
     * archived Session, so the list row is hidden in the DOM instead: the
     * workspace browser renders each Session as `[data-row-key="session:<id>"]`,
     * and we own the exact ids inside this plugin's local entry map.
     */
    function installSessionRowHider(scope) {
      function syncRows() {
        try {
          var style = document.querySelector('style[data-plugin="dsh-quote-ask-rows"]')
          if (style === null) {
            style = document.createElement('style')
            style.dataset.plugin = 'dsh-quote-ask-rows'
            document.head.appendChild(style)
          }
          var entries = readSessionEntries()
          var rules = []
          for (var sessionId of Object.keys(entries)) {
            if (!SAFE_ID.test(sessionId)) continue
            rules.push('[data-row-key="session:' + sessionId + '"]{display:none !important}')
          }
          style.textContent = rules.join('\n')
        } catch {
          /* list hygiene only */
        }
      }
      scope.effect(
        function () {
          syncRows()
          var off = subscribeEntriesChanged(syncRows)
          return function () {
            off()
            try {
              var style = document.querySelector('style[data-plugin="dsh-quote-ask-rows"]')
              if (style !== null) style.remove()
            } catch {
              /* document may be tearing down */
            }
          }
        },
        'quote-ask: hide session rows',
      )
    }

    function installSelectionMenu(scope) {
      scope.slots.inject('shell.overlay', function () {
        return scope.slots.register({ name: 'shell.overlay', id: MENU_ID, order: 950 }, makeSelectionMenu(scope))
      })
    }

    // Contract-test entry: only exposed when the test harness asks for it, so
    // the shipped module keeps the platform's exact { inject, apply } shape.
    if (window.__DSH_SIDE_CHAT_CONTRACT_TEST__ === true) {
      window.__dshSideChatTest = {
        openSideChat: openSideChat,
        appendQuoteToSideChat: appendQuoteToSideChat,
        removeQuoteFromSideChat: removeQuoteFromSideChat,
        addQuoteToMainConversation: addQuoteToMainConversation,
        removeMainQuoteFromConversation: removeMainQuoteFromConversation,
        normalizeQuote: normalizeQuote,
        activeQuoteListForMain: activeQuoteListForMain,
        sideQuoteNumberOffset: sideQuoteNumberOffset,
        sideEntriesForMain: sideEntriesForMain,
      }
    }

    return {
      // Hard client dependencies: the right-sidebar tab, the conversation
      // factory, resource model, and the session controller. The Desktop profile
      // always provides all five; a missing one is a wiring error, not a state
      // the plugin should silently idle in.
      inject: ['slots', 'sessions', 'resources', 'sidebarRight', 'sidebarRightTabs'],
      apply: function apply(ctx) {
        // Remove drafts this plugin left in DSH's per-session localStorage
        // before serving new side chats (one-time migration for earlier builds).
        scrubLegacySideChatLocalState()
        purgeLegacyQuoteAskState()
        purgeSideChatStateOnBoot(ctx)
        installStyles(ctx)
        installTranscriptHighlight(ctx)
        installResourceProvider(ctx)
        installTabType(ctx)
        installTabBody(ctx)
        installConversationSlot(ctx)
        installCloseHandler(ctx)
        installQuoteChip(ctx)
        installSessionRowHider(ctx)
        installSelectionMenu(ctx)
        void retryPendingCleanups(ctx)
      },
    }
  },
})
