/**
 * dsh-quote-ask contract test (no DSH runtime required).
 *
 * Runs with the bundled Node binary:
 *   node verify.mjs
 *
 * It imports the real host half (with DSH_HOME redirected to a temp directory)
 * and the real client bundle (with a stubbed module loader / DOM), then
 * exercises: path encoding, prepare/bind/cleanup routes, the model-only context
 * file + system-prompt section, the two-phase journal + boot verification,
 * markerless reaping gating, ownership proofs, v0.2 journal migration, and the
 * client registration/open/cleanup wiring.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TMP_HOME = mkdtempSync(join(tmpdir(), 'dsh-quote-ask-test-'))
process.env.DSH_HOME = TMP_HOME
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const SIDE_ROOT = join(TMP_HOME, 'quote-ask')
const SESSIONS_ROOT = join(TMP_HOME, 'sessions')
const PROJCACHE_DIR = join(TMP_HOME, 'storages', 'session_projcache', 'sessions')
const MAIN_CWD = join(TMP_HOME, 'main-workspace')
mkdirSync(MAIN_CWD, { recursive: true })
const MAIN_SESSION_ID = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const logs = []
/** @type {Map<string, any>} */
const liveSessions = new Map()
/** @type {Map<string, any>} */
const coldSessions = new Map()
/** Prompt-section registrations captured from the host half. */
const promptSections = []

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(body) {
      this.body = body === undefined ? '' : String(body)
    },
  }
}

function makeReq(method, payload) {
  const listeners = { data: [], end: [], error: [], close: [] }
  const request = {
    method,
    headers: { 'content-type': 'application/json' },
    on(event, callback) {
      if (listeners[event] !== undefined) listeners[event].push(callback)
      return request
    },
  }
  setImmediate(() => {
    if (payload !== undefined) {
      for (const callback of listeners.data) callback(Buffer.from(JSON.stringify(payload)))
    }
    for (const callback of listeners.end) callback()
    for (const callback of listeners.close) callback()
  })
  return request
}

function makeHostContext() {
  const routes = new Map()
  const workspaceArchive = []
  const workspaceUnarchive = []
  const workspaceRegistry = {
    async archiveSession(sessionId) {
      workspaceArchive.push(sessionId)
    },
    async unarchiveSession(sessionId) {
      workspaceUnarchive.push(sessionId)
    },
  }
  const scope = {
    effect(callback, label) {
      if (String(label).includes('startup sweep')) return () => {}
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(_deps, callback) {
      return callback(scope)
    },
    systemPrompt: {
      section(options) {
        promptSections.push(options)
        return () => {}
      },
      getSectionOrder() {
        throw new Error('custom sections pass a numeric order')
      },
    },
    get(service) {
      if (service === 'connection') return { requestRejection: () => undefined }
      if (service === 'sessions') return { get: (sessionId) => liveSessions.get(sessionId) }
      if (service === 'workspaceRegistry') return workspaceRegistry
      if (service === 'sessionQuery') {
        return {
          async observeSession(sessionId) {
            const session = coldSessions.get(sessionId) || liveSessions.get(sessionId)
            if (session === undefined) throw new Error('session not found: ' + sessionId)
            return {
              header: session.header,
              events: typeof session.events === 'function' ? session.events() : (session.events || []),
              [Symbol.dispose]() {},
            }
          },
        }
      }
      if (service === 'systemPrompt') return scope.systemPrompt
      return undefined
    },
    logger: { warn: (...args) => logs.push(args.join(' ')) },
    webServer: {
      register(options) {
        routes.set(options.path, options.handler)
        return () => {}
      },
    },
  }
  return { ctx: scope, routes, workspaceArchive, workspaceUnarchive }
}

async function callRoute(routes, endpoint, payload) {
  const handler = routes.get('/dsh-quote-ask/' + endpoint)
  assert.equal(typeof handler, 'function', 'missing route ' + endpoint)
  const response = makeRes()
  const request = makeReq(payload === undefined ? 'GET' : 'POST', payload)
  handler(request, response)
  const deadline = Date.now() + 3000
  while (response.status === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  let parsed = null
  try {
    parsed = JSON.parse(response.body)
  } catch {
    parsed = null
  }
  return { status: response.status, body: parsed }
}

function writeProjectionCache(sessionId, cwd) {
  mkdirSync(PROJCACHE_DIR, { recursive: true })
  writeFileSync(
    join(PROJCACHE_DIR, sessionId + '.json'),
    JSON.stringify({ version: 7, record: { identity: { formatVersion: 4, createdAt: 1, cwd, isSeeded: false, inheritedEventCount: 0 }, rows: {} } }, null, 2),
    'utf8',
  )
}

function sessionLogDirectory(sessionId, cwd, host) {
  const bucket = host.__testHooks.projectKey(cwd)
  const directory = join(SESSIONS_ROOT, bucket, host.__testHooks.encodeSegment(sessionId))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'session.v4.jsonl.zstd'), 'fake', 'utf8')
  return directory
}

function readJournal() {
  try {
    return JSON.parse(readFileSync(join(SIDE_ROOT, 'journal.json'), 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  const host = await import(pathToFileURL(join(PACKAGE_DIR, 'lib', 'index.js')).href)
  const hooks = host.__testHooks

  /* 1) Path encoding matches the real session-persistence bucket names. */
  assert.equal(hooks.projectKey('C:\\Users\\example\\.dsh\\demo'), '--C-Users-example-.dsh-demo--')
  assert.equal(hooks.projectKey('D:\\Projects\\demo'), '--D-Projects-demo--')
  assert.equal(hooks.encodeSegment('session-11111111-1111-4111-8111-111111111111'), 'session-11111111-1111-4111-8111-111111111111')
  assert.equal(hooks.inside('C:\\a', 'C:\\a\\b'), true)
  assert.equal(hooks.inside('C:\\a', 'C:\\a'), false)
  assert.equal(hooks.inside('C:\\a', 'C:\\b\\c'), false)
  assert.equal(hooks.normalizeQuoteText('  a\r\nb  '), 'a\nb', 'quote text normalised')

  /* 2) Host routes: prepare (context file) -> bind (archive) -> append quote -> cleanup. */
  const { ctx, routes: routeMap, workspaceArchive, workspaceUnarchive } = makeHostContext()
  host.apply(ctx)

  const mainEvents = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请帮我分析这道极限题，顺便看第二条引用片段' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我们先看分母的等价无穷小。' }] } } },
    { type: 'user/message', data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'runtime snapshot that must be skipped' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'read' }, { type: 'text', text: '我读一下题目文件。' }] } } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '工具结果：分母在 x→0 时等价于 x。' }] } } },
  ]
  liveSessions.set(MAIN_SESSION_ID, { header: { cwd: MAIN_CWD }, events: () => mainEvents })

  const sideChatId = '22222222-2222-4222-8222-222222222222'
  const prepared = await callRoute(routeMap, 'prepare', {
    sideChatId,
    mainSessionId: MAIN_SESSION_ID,
    quote: '用户选中的关键片段',
    anchor: {
      nodeKey: 'assistant-step:3:1',
      flowKind: 'assistant-step',
      turn: 2,
      charStart: 12,
      charEnd: 20,
      messageLength: 400,
      before: '引用片段前面的原文。',
      after: '引用片段后面的原文。',
      messageText: '这是被引用的完整消息文本：用户选中的关键片段出现在这里。',
    },
  })
  assert.equal(prepared.status, 200, 'prepare status')
  assert.equal(prepared.body.ok, true)
  const workspace = prepared.body.dir
  assert.equal(workspace, join(SIDE_ROOT, sideChatId, 'workspace'))
  assert.equal(existsSync(workspace), true)

  const contextPath = join(SIDE_ROOT, sideChatId, 'context.md')
  assert.equal(existsSync(contextPath), true, 'model-only context file written')
  const contextText = readFileSync(contextPath, 'utf8')
  assert.ok(contextText.includes('用户选中的关键片段'), 'quote in context')
  assert.ok(contextText.includes('请帮我分析这道极限题'), 'user transcript in context')
  assert.ok(contextText.includes('我们先看分母的等价无穷小'), 'assistant transcript in context')
  assert.ok(contextText.includes('我读一下题目文件'), 'assistant text with tool call kept')
  assert.ok(!contextText.includes('runtime snapshot that must be skipped'), 'plugin runtime snapshots skipped')
  assert.ok(contextText.includes('不要接着主对话'), 'independent-question instruction present')
  assert.ok(contextText.includes('引用 1'), 'quote numbered in the model-only context')
  assert.ok(contextText.includes('工具结果：分母在 x→0 时等价于 x'), 'tool result kept in the model context')
  assert.ok(contextText.includes('再次强调'), 'quote emphasized again after the transcript')
  assert.ok(contextText.includes('引用片段的精确位置'), 'precise quote location section present')
  assert.ok(contextText.includes('字符偏移'), 'character offsets recorded')
  assert.ok(contextText.includes('引用片段前面的原文'), 'surrounding before text recorded')
  assert.ok(contextText.includes('这是被引用的完整消息文本'), 'full quoted message text recorded')

  // The system-prompt section is model-visible only for quote-ask sessions.
  assert.equal(promptSections.length, 1, 'one prompt section registered')
  const promptSection = promptSections[0]
  assert.equal(promptSection.name, 'quote-ask:context')
  assert.equal(promptSection.interpolate, false)
  assert.equal(promptSection.text({ agent: { session: { header: { cwd: workspace } } } }), contextText, 'section text for side chat')
  assert.equal(promptSection.text({ agent: { session: { header: { cwd: MAIN_CWD } } } }), '', 'main conversation untouched')
  assert.equal(promptSection.text({ agent: { session: { header: { cwd: 'C:\\elsewhere' } } } }), '', 'foreign session untouched')
  assert.equal(promptSection.text({}), '', 'root prompt has no quote-ask section')

  // Regression: a Chinese context file is ~3 bytes per character. The old byte
  // cap silently returned an empty system-prompt section for it.
  const bigSideChatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const bigSideDir = join(SIDE_ROOT, bigSideChatId)
  mkdirSync(join(bigSideDir, 'workspace'), { recursive: true })
  const bigContext = '测'.repeat(70000)
  writeFileSync(join(bigSideDir, 'context.md'), bigContext, 'utf8')
  const bigSection = hooks.sideChatPromptContext({
    agent: { session: { header: { cwd: join(bigSideDir, 'workspace') } } },
  })
  assert.equal(bigSection.length, bigContext.length, 'large UTF-8 context file is injected')
  rmSync(bigSideDir, { recursive: true, force: true })

  const sessionId = 'session-11111111-1111-4111-8111-111111111111'
  writeProjectionCache(sessionId, workspace)
  const logDirectory = sessionLogDirectory(sessionId, workspace, host)
  liveSessions.set(sessionId, { header: { cwd: workspace } })

  const bound = await callRoute(routeMap, 'bind', { sideChatId, sessionId })
  assert.equal(bound.status, 200, 'bind status')
  assert.equal(bound.body.ok, true)
  assert.equal(workspaceArchive.length, 0, 'quote-ask session is not archived (archive blocks model steps)')

  const appended = await callRoute(routeMap, 'append-quote', { sideChatId, quote: '第二条引用片段' })
  assert.equal(appended.status, 200, 'append-quote status')
  assert.equal(appended.body.quoteCount, 2, 'second quote stored')
  const contextAfterAppend = readFileSync(contextPath, 'utf8')
  assert.ok(contextAfterAppend.includes('第二条引用片段'), 'appended quote in model context')
  assert.ok(contextAfterAppend.includes('共 2 条'), 'quote count in model context')
  const sectionAfterAppend = promptSection.text({ agent: { session: { header: { cwd: workspace } } } })
  assert.ok(sectionAfterAppend.includes('第二条引用片段'), 'system prompt sees the appended quote')

  // Regression: a quoted message can be long. The anchor payload used to exceed
  // the 64KB request-body cap and append-quote answered invalid-body.
  const largeAnchorAppend = await callRoute(routeMap, 'append-quote', {
    sideChatId,
    quote: '长消息里的引用',
    anchor: {
      nodeKey: 'assistant-step:30:1',
      flowKind: 'assistant-step',
      turn: 12,
      charStart: 100,
      charEnd: 108,
      messageLength: 30000,
      before: '长消息前文',
      after: '长消息后文',
      messageText: '长'.repeat(30000),
    },
  })
  assert.equal(largeAnchorAppend.status, 200, 'large quote anchor body accepted')
  assert.equal(largeAnchorAppend.body.ok, true, 'large quote anchor is not rejected as invalid-body')
  assert.equal(largeAnchorAppend.body.quoteCount, 3, 'large quote anchor appended')

  const removedQuote = await callRoute(routeMap, 'remove-quote', { sideChatId, quote: '第二条引用片段' })
  assert.equal(removedQuote.status, 200, 'remove-quote status')
  assert.equal(removedQuote.body.quoteCount, 2, 'removed quote count')
  const contextAfterRemove = readFileSync(contextPath, 'utf8')
  assert.ok(!contextAfterRemove.includes('第二条引用片段'), 'removed quote is gone from the model context')
  assert.ok(contextAfterRemove.includes('长消息里的引用'), 'other quotes remain in the model context')
  const missingQuote = await callRoute(routeMap, 'remove-quote', { sideChatId, quote: '不存在的引用片段' })
  assert.equal(missingQuote.status, 400, 'removing an unknown quote fails')

  const spillRoot = join(tmpdir(), 'dsh-spill-quoteask-test-' + Math.random().toString(36).slice(2, 8))
  const spillHash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  const spillDirectory = join(spillRoot, 'session-' + spillHash)
  mkdirSync(spillDirectory, { recursive: true })
  writeFileSync(join(spillDirectory, 'tool-result.txt'), 'x', 'utf8')

  const cleaned = await callRoute(routeMap, 'cleanup', { sideChatId, sessionId })
  assert.equal(cleaned.status, 200, 'cleanup status')
  assert.deepEqual(cleaned.body.failed, [], 'cleanup failed list')
  assert.ok(workspaceUnarchive.includes(sessionId), 'deleted quote-ask session unarchived for list hygiene')
  assert.equal(existsSync(join(SIDE_ROOT, sideChatId)), false, 'quote-ask dir, workspace and context removed')
  assert.equal(existsSync(logDirectory), false, 'session log removed')
  assert.equal(existsSync(join(PROJCACHE_DIR, sessionId + '.json')), false, 'projection cache removed')
  assert.equal(existsSync(spillDirectory), false, 'spill directory removed')

  const journalAfterClose = readJournal()
  assert.ok(journalAfterClose && journalAfterClose.pending[sideChatId], 'verify journal entry kept')
  assert.equal(journalAfterClose.pending[sideChatId].phase, 'verify')
  assert.equal(journalAfterClose.pending[sideChatId].proofKind, 'live')

  /* 3) Two-phase cleanup: a disposal-time cache rewrite is removed by the next boot sweep. */
  writeProjectionCache(sessionId, workspace)
  hooks.sweepSideChats({ logger: { warn: (...args) => logs.push(args.join(' ')) } })
  assert.equal(existsSync(join(PROJCACHE_DIR, sessionId + '.json')), false, 'resurrected cache removed by sweep')
  const journalAfterSweep = readJournal()
  assert.equal(Object.keys(journalAfterSweep ? journalAfterSweep.pending : {}).length, 0, 'journal retired by sweep')

  /* 4) v0.2 journal entries (fork-era proof vocabulary) are retired, not stuck. */
  const legacySideChatId = 'aaaaaaaa-0000-4000-8000-000000000001'
  const legacySessionId = 'session-aaaaaaaa-0000-4000-8000-000000000001'
  const legacy = JSON.parse(readFileSync(join(SIDE_ROOT, 'journal.json'), 'utf8'))
  legacy.pending[legacySideChatId] = {
    sideChatId: legacySideChatId,
    sessionId: legacySessionId,
    cwd: MAIN_CWD,
    mainSessionId: MAIN_SESSION_ID,
    phase: 'verify',
    proofKind: 'fork',
    provenSessionId: legacySessionId,
    candidateSessionId: legacySessionId,
    markerObserved: true,
    updatedAt: new Date().toISOString(),
  }
  writeFileSync(join(SIDE_ROOT, 'journal.json'), JSON.stringify(legacy), 'utf8')
  const legacyResult = hooks.cleanupSideChat({ sideChatId: legacySideChatId }, { scoped: ctx, finalize: true })
  assert.deepEqual(legacyResult.failed, [], 'v0.2 journal entry cleanup succeeds')
  assert.equal(readJournal().pending[legacySideChatId], undefined, 'v0.2 journal entry retired')

  /* 4b) A v0.2 fork side chat still marked open is retired on the first boot. */
  const legacyForkSideId = 'aaaaaaaa-0000-4000-8000-000000000002'
  const legacyForkSessionId = 'session-aaaaaaaa-0000-4000-8000-000000000002'
  mkdirSync(join(SIDE_ROOT, legacyForkSideId), { recursive: true })
  writeFileSync(
    join(SIDE_ROOT, legacyForkSideId, 'marker.json'),
    JSON.stringify({
      version: 3,
      sideChatId: legacyForkSideId,
      mainSessionId: MAIN_SESSION_ID,
      sessionId: legacyForkSessionId,
      sourceCwd: MAIN_CWD,
      status: 'open',
      ownershipVerified: true,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }),
    'utf8',
  )
  const legacyForkLog = sessionLogDirectory(legacyForkSessionId, MAIN_CWD, host)
  writeProjectionCache(legacyForkSessionId, MAIN_CWD)
  hooks.sweepSideChats({ logger: { warn: (...args) => logs.push(args.join(' ')) } })
  assert.equal(existsSync(join(SIDE_ROOT, legacyForkSideId)), false, 'v0.2 fork side chat retired on boot')
  assert.equal(existsSync(legacyForkLog), false, 'v0.2 fork child log removed')
  assert.equal(existsSync(join(PROJCACHE_DIR, legacyForkSessionId + '.json')), false, 'v0.2 fork child cache removed')

  /* 5) Markerless reaping gate: uuid-shaped + workspace/ + old is removed; user-named dir kept. */
  const orphanId = '33333333-3333-4333-8333-333333333333'
  const orphanDirectory = join(SIDE_ROOT, orphanId)
  mkdirSync(join(orphanDirectory, 'workspace'), { recursive: true })
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  utimesSync(orphanDirectory, old, old)
  const userDirectory = join(SIDE_ROOT, 'my-notes')
  mkdirSync(join(userDirectory, 'workspace'), { recursive: true })
  utimesSync(userDirectory, old, old)
  hooks.sweepSideChats({ logger: { warn: (...args) => logs.push(args.join(' ')) } })
  assert.equal(existsSync(orphanDirectory), false, 'old markerless quote-ask dir reaped')
  assert.equal(existsSync(userDirectory), true, 'non-uuid directory preserved')

  /* 6) Ownership proof: a bind from another cwd is refused and foreign artifacts survive. */
  const victimSessionId = 'session-44444444-4444-4444-8444-444444444444'
  const foreignSideChatId = '55555555-5555-4555-8555-555555555555'
  const foreignPrepared = await callRoute(routeMap, 'prepare', {
    sideChatId: foreignSideChatId,
    mainSessionId: MAIN_SESSION_ID,
    quote: '另一个侧聊',
  })
  assert.equal(foreignPrepared.status, 200, 'second prepare works')
  liveSessions.set(victimSessionId, { header: { cwd: MAIN_CWD } })
  const victimLogDirectory = sessionLogDirectory(victimSessionId, MAIN_CWD, host)
  writeProjectionCache(victimSessionId, MAIN_CWD)
  assert.throws(
    () => hooks.bindSideChat(foreignSideChatId, victimSessionId, ctx),
    /does not belong/,
    'bind refuses a session from another cwd',
  )
  hooks.cleanupSideChat({ sideChatId: foreignSideChatId }, { scoped: ctx })
  assert.equal(existsSync(victimLogDirectory), true, 'foreign session log untouched')
  assert.equal(existsSync(join(PROJCACHE_DIR, victimSessionId + '.json')), true, 'foreign projection cache untouched')

  /* 6b) A marker that claims a foreign session cannot delete its artifacts either. */
  const claimedSideChatId = '66666666-6666-4666-8666-666666666666'
  await callRoute(routeMap, 'prepare', { sideChatId: claimedSideChatId, mainSessionId: MAIN_SESSION_ID, quote: 'claim' })
  const markerPath = join(SIDE_ROOT, claimedSideChatId, 'marker.json')
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  marker.sessionId = victimSessionId
  marker.status = 'open'
  marker.ownershipVerified = false
  writeFileSync(markerPath, JSON.stringify(marker), 'utf8')
  const claimedResult = hooks.cleanupSideChat({ sideChatId: claimedSideChatId }, { scoped: ctx })
  assert.ok(claimedResult.failed.some((entry) => entry.startsWith('unproven-session:')), 'unproven session reported')
  assert.equal(existsSync(victimLogDirectory), true, 'claimed foreign log untouched')
  assert.equal(existsSync(join(PROJCACHE_DIR, victimSessionId + '.json')), true, 'claimed foreign cache untouched')

  /* 6c) A main conversation that cannot be read still opens with quote-only context. */
  const coldSideChatId = '77777777-7777-4777-8777-777777777777'
  const coldPrepared = await callRoute(routeMap, 'prepare', {
    sideChatId: coldSideChatId,
    mainSessionId: 'session-deadbeef-dead-4ead-8ead-deadbeefdead',
    quote: '孤立引用',
  })
  assert.equal(coldPrepared.status, 200, 'prepare still works without readable history')
  const coldContext = readFileSync(join(SIDE_ROOT, coldSideChatId, 'context.md'), 'utf8')
  assert.ok(coldContext.includes('孤立引用'), 'quote kept')
  assert.ok(coldContext.includes('没有读取到可用的主对话文本'), 'missing history noted')
  hooks.cleanupSideChat({ sideChatId: coldSideChatId }, { scoped: ctx })

  /* 6d) A side chat left open by a previous DSH run is deleted by the startup sweep. */
  const restartSideChatId = '88888888-8888-4888-8888-888888888888'
  const restartSessionId = 'session-88888888-8888-4888-8888-888888888888'
  const restartWorkspace = join(SIDE_ROOT, restartSideChatId, 'workspace')
  hooks.prepareSideChat(restartSideChatId, MAIN_SESSION_ID, 'restart context', [{ text: '重启前引用' }])
  liveSessions.set(restartSessionId, { header: { cwd: restartWorkspace }, events: () => [] })
  hooks.bindSideChat(restartSideChatId, restartSessionId, ctx)
  const restartLog = sessionLogDirectory(restartSessionId, restartWorkspace, host)
  writeProjectionCache(restartSessionId, restartWorkspace)
  hooks.sweepSideChats(ctx, { bootAt: Date.now() + 1000 })
  assert.equal(existsSync(join(SIDE_ROOT, restartSideChatId)), false, 'open side chat from previous run removed at boot')
  assert.equal(existsSync(restartLog), false, 'previous-run session log removed at boot')
  assert.equal(existsSync(join(PROJCACHE_DIR, restartSessionId + '.json')), false, 'previous-run projection cache removed at boot')

  /* 6e) Host disposal deletes still-open side chats. */
  const shutdownSideChatId = '99999999-9999-4999-8999-999999999999'
  const shutdownSessionId = 'session-99999999-9999-4999-8999-999999999999'
  const shutdownWorkspace = join(SIDE_ROOT, shutdownSideChatId, 'workspace')
  hooks.prepareSideChat(shutdownSideChatId, MAIN_SESSION_ID, 'shutdown context', [{ text: '关机前引用' }])
  liveSessions.set(shutdownSessionId, { header: { cwd: shutdownWorkspace }, events: () => [] })
  hooks.bindSideChat(shutdownSideChatId, shutdownSessionId, ctx)
  hooks.cleanupOpenSideChatsForShutdown()
  assert.equal(existsSync(join(SIDE_ROOT, shutdownSideChatId)), false, 'disposing the Host removes open side chats')

  /* 6f) Main-conversation "添加至对话": attach, prompt section, turn lifecycle, remove. */
  const mainQuoteAnchor = {
    nodeKey: 'assistant-step:40:1',
    flowKind: 'assistant-step',
    turn: 20,
    charStart: 120,
    charEnd: 128,
    messageLength: 500,
    before: '引用前面的话。',
    after: '引用后面的话。',
    messageText: '包含主对话引用片段的整条消息。',
  }
  const attachedMain = await callRoute(routeMap, 'attach-main-quote', {
    mainSessionId: MAIN_SESSION_ID,
    quote: '主对话引用片段',
    anchor: mainQuoteAnchor,
  })
  assert.equal(attachedMain.status, 200, 'attach-main-quote status')
  assert.equal(attachedMain.body.quoteCount, 1, 'one main quote attached')
  const mainPromptContext = { agent: { session: { header: { id: MAIN_SESSION_ID, cwd: MAIN_CWD } } } }
  assert.ok(promptSection.text(mainPromptContext).includes('主对话引用片段'), 'attached quote visible in the main system prompt')
  assert.ok(promptSection.text(mainPromptContext).includes('引用前面的话'), 'precise anchor in the main prompt context')
  const listedMain = await callRoute(routeMap, 'main-quotes-list', { mainSessionId: MAIN_SESSION_ID })
  assert.equal(listedMain.status, 200, 'main-quotes-list status')
  assert.equal(listedMain.body.quotes.length, 1, 'main quote list returns the attachment')

  hooks.handleMainQuoteTurnEvent({ id: MAIN_SESSION_ID }, { type: 'turn/start' })
  assert.ok(promptSection.text(mainPromptContext).includes('主对话引用片段'), 'active turn keeps the quote')
  // A quote attached while the turn is already running belongs to the NEXT turn.
  await callRoute(routeMap, 'attach-main-quote', { mainSessionId: MAIN_SESSION_ID, quote: '下一轮引用', anchor: null })
  assert.ok(!promptSection.text(mainPromptContext).includes('下一轮引用'), 'quote attached mid-turn waits for the next turn')
  hooks.handleMainQuoteTurnEvent({ id: MAIN_SESSION_ID }, { type: 'turn/end' })
  assert.ok(!promptSection.text(mainPromptContext).includes('主对话引用片段'), 'finished turn clears its active quote')
  assert.ok(promptSection.text(mainPromptContext).includes('下一轮引用'), 'pending quote survives for the next turn')
  const removedMain = await callRoute(routeMap, 'remove-main-quote', {
    mainSessionId: MAIN_SESSION_ID,
    quote: '下一轮引用',
    anchor: null,
  })
  assert.equal(removedMain.status, 200, 'remove-main-quote status')
  assert.equal(removedMain.body.quoteCount, 0, 'removing the last main quote empties the state')
  assert.equal(promptSection.text(mainPromptContext), '', 'main prompt is untouched without attachments')
  hooks.clearAllMainQuotes()

  /* 7) Clean up the test home. */
  rmSync(TMP_HOME, { recursive: true, force: true })
  rmSync(spillRoot, { recursive: true, force: true })

  /* 8) Client bundle: factory registers the module and apply() wires every extension point. */
  const clientPath = join(PACKAGE_DIR, 'lib', 'client', 'index.js')
  const declaredSlots = new Set(['sidebar.right.pane.tab', 'shell.overlay', 'conversation.input.left'])
  const registered = { tabTypes: [], resources: [], slots: [], closeHandlers: [], overlay: [] }
  let clientExports = null
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        assert.equal(definition.id, 'dsh-quote-ask')
        const reactStub = {
          createElement: () => null,
          Fragment: {},
          useState: () => [null, () => {}],
          useEffect: () => {},
          useRef: () => ({ current: false }),
          useCallback: (fn) => fn,
        }
        const reactDomStub = { createPortal: () => null }
        clientExports = definition.factory((id) => {
          if (id === 'react') return reactStub
          if (id === 'react-dom') return reactDomStub
          throw new Error('unexpected require ' + id)
        })
      },
    },
    localStorage: (() => {
      const store = new Map()
      return {
        get length() {
          return store.size
        },
        key(index) {
          return Array.from(store.keys())[index] ?? null
        },
        getItem(key) {
          return store.has(key) ? store.get(key) : null
        },
        setItem(key, value) {
          store.set(key, String(value))
        },
        removeItem(key) {
          store.delete(key)
        },
      }
    })(),
    sessionStorage: (() => {
      const store = new Map()
      return {
        getItem(key) {
          return store.has(key) ? store.get(key) : null
        },
        setItem(key, value) {
          store.set(key, String(value))
        },
      }
    })(),
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, 0),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    innerWidth: 1280,
    innerHeight: 800,
    getSelection: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = {
    head: { appendChild: () => {} },
    body: {},
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  // One-time scrub fixture: DSH persists each conversation's composer draft at
  // `dsh.conversation.<sessionId>`; earlier builds left a quote-ask draft behind.
  const legacyDraftKey = 'dsh.conversation.session-legacy'
  const graveyardDraftKey = 'dsh.conversation.session-dead'
  const normalDraftKey = 'dsh.conversation.session-alive'
  globalThis.window.localStorage.setItem(
    legacyDraftKey,
    JSON.stringify({ draft: { text: '以下内容是我在 DSH 主对话中选中的片段，请把它作为这次提问的上下文：\n<<<\nfoo\n>>>' } }),
  )
  globalThis.window.localStorage.setItem(graveyardDraftKey, JSON.stringify({ draft: { text: 'quoted' } }))
  globalThis.window.localStorage.setItem(normalDraftKey, JSON.stringify({ draft: { text: 'ordinary draft' } }))
  globalThis.window.localStorage.setItem('dsh-quote-ask.graveyard.v1', JSON.stringify(['session-dead']))
  // DSH-restart fixture: a previous run left quote-ask entries, a draft and a
  // restored quote-ask tab in the saved right-sidebar layout.
  const staleSessionId = 'session-55555555-5555-4555-8555-555555555555'
  const savedLayoutKey = 'dsh.sidebar-right.v1.session-main'
  globalThis.window.localStorage.setItem(
    'dsh-quote-ask.sessions.v1',
    JSON.stringify({
      [staleSessionId]: {
        sideChatId: '55555555-5555-4555-8555-555555555555',
        sessionId: staleSessionId,
        mainSessionId: MAIN_SESSION_ID,
        mainTitle: '旧侧聊',
        quotes: ['旧引用'],
        createdAt: Date.now(),
      },
    }),
  )
  globalThis.window.localStorage.setItem('dsh.conversation.' + staleSessionId, JSON.stringify({ draft: { text: 'stale' } }))
  globalThis.window.localStorage.setItem(
    savedLayoutKey,
    JSON.stringify({
      bySession: {
        'session-main': {
          layout: {
            nodes: {
              pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: ['tab-side', 'tab-guide'], activeTabId: 'tab-side' },
            },
            tabs: {
              'tab-side': { id: 'tab-side', kind: 'quoteask', contentId: 'dsh-resource://quoteask/session/' + staleSessionId, title: '侧聊' },
              'tab-guide': { id: 'tab-guide', kind: 'guide', contentId: 'dsh-resource://guide/page', title: '开始' },
            },
            rootId: 'pane1',
            floats: [],
            activePaneId: 'pane1',
            expanded: false,
            mode: 'push',
          },
          minted: 2,
        },
      },
    }),
  )
  globalThis.window.localStorage.setItem('dsh-quote-ask.main-quotes.v1', JSON.stringify({
    [MAIN_SESSION_ID]: [{ text: '旧的主对话引用', anchor: null }],
  }))
  globalThis.window.__DSH_SIDE_CHAT_CONTRACT_TEST__ = true
  await import(pathToFileURL(clientPath).href)
  assert.ok(clientExports && typeof clientExports.apply === 'function', 'client module loaded')
  const clientTest = globalThis.window.__dshSideChatTest
  assert.ok(clientTest && typeof clientTest.openSideChat === 'function', 'client test entry exposed only for the harness')
  assert.deepEqual(clientExports.inject, ['slots', 'sessions', 'resources', 'sidebarRight', 'sidebarRightTabs'])

  const clientCtx = {
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots: {
      inject(name, register) {
        if (declaredSlots.has(name)) register()
      },
      register(options, component) {
        assert.equal(typeof component, 'function')
        registered.slots.push(options)
        if (options.children) {
          for (const childName of Object.keys(options.children)) declaredSlots.add(childName)
        }
        return () => {}
      },
    },
    resources: {
      register(provider) {
        registered.resources.push(provider)
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        registered.tabTypes.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      registerCloseHandler(kind, handler) {
        registered.closeHandlers.push({ kind, handler })
        return () => {}
      },
      openResource() {},
    },
  }
  clientExports.apply(clientCtx)
  assert.equal(globalThis.window.localStorage.getItem('dsh-quote-ask.sessions.v1'), null, 'stale quote-ask entries purged on DSH boot')
  assert.equal(globalThis.window.localStorage.getItem('dsh-quote-ask.main-quotes.v1'), null, 'stale main-conversation attachments purged on DSH boot')
  assert.equal(globalThis.window.localStorage.getItem('dsh.conversation.' + staleSessionId), null, 'stale quote-ask draft purged on DSH boot')
  const savedLayoutAfterPurge = JSON.parse(globalThis.window.localStorage.getItem(savedLayoutKey))
  const savedSurface = savedLayoutAfterPurge.bySession['session-main']
  assert.equal(savedSurface.layout.tabs['tab-side'], undefined, 'quote-ask tab removed from saved layout')
  assert.ok(savedSurface.layout.tabs['tab-guide'], 'unrelated guide tab preserved')
  assert.deepEqual(savedSurface.layout.nodes.pane1.tabs, ['tab-guide'], 'pane no longer lists the quote-ask tab')
  assert.equal(savedSurface.layout.nodes.pane1.activeTabId, 'tab-guide', 'active tab falls back to the remaining tab')
  assert.equal(globalThis.window.localStorage.getItem(legacyDraftKey), null, 'legacy quote-ask draft scrubbed by marker')
  assert.equal(globalThis.window.localStorage.getItem(graveyardDraftKey), null, 'draft removed via cleanup graveyard')
  const graveyardAfterBootScrub = JSON.parse(globalThis.window.localStorage.getItem('dsh-quote-ask.graveyard.v1') || '[]')
  assert.ok(!graveyardAfterBootScrub.includes('session-dead'), 'stale graveyard record pruned after draft scrub')
  assert.ok(globalThis.window.localStorage.getItem(normalDraftKey) !== null, 'unrelated conversation draft preserved')
  assert.equal(registered.resources.length, 1)
  assert.equal(registered.resources[0].protocol, 'quoteask')
  assert.equal(registered.tabTypes.length, 1)
  assert.equal(registered.tabTypes[0].id, 'dsh-quote-ask')
  assert.equal(registered.tabTypes[0].kind, 'quoteask')
  assert.deepEqual(registered.tabTypes[0].patterns, ['dsh-resource://quoteask/session/**'])
  const paneBody = registered.slots.find((options) => options.name === 'sidebar.right.pane.tab')
  assert.ok(paneBody && paneBody.key === 'dsh-quote-ask', 'tab body registered under the definition id')
  assert.deepEqual(Object.keys(paneBody.children), ['dsh-quote-ask.conversation'])
  assert.ok(
    registered.slots.some((options) => options.name === 'dsh-quote-ask.conversation'),
    'conversation child slot registered',
  )
  assert.equal(registered.closeHandlers.length, 1)
  assert.equal(registered.closeHandlers[0].kind, 'quoteask')
  const overlay = registered.slots.find((options) => options.name === 'shell.overlay')
  assert.ok(overlay && overlay.id === 'dsh-quote-ask.selection-menu', 'selection menu host registered')
  const quoteChip = registered.slots.find((options) => options.name === 'conversation.input.left')
  assert.ok(quoteChip && quoteChip.id === 'dsh-quote-ask-quotes', 'quote chip registered inside the composer')

  /* 9) Client open flow: prepare with the quote -> create a blank scratch
   *    session -> bind -> open the tab; the quote is stored for the card and
   *    nothing is prefilled into the composer. */
  const calls = { create: [], commands: [], opens: [], renames: [], http: [] }
  let childId = 'session-ffffffff-ffff-4fff-8fff-ffffffffffff'
  let failEndpoint = null
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url).split('/').pop()
    const body = init && init.body ? JSON.parse(init.body) : {}
    calls.http.push({ endpoint, body })
    if (endpoint === failEndpoint) {
      return { ok: false, status: 400, async json() { return { ok: false, error: 'forced failure' } } }
    }
    return {
      ok: true,
      status: 200,
      async json() {
        if (endpoint === 'cleanup') return { ok: true, failed: [] }
        if (endpoint === 'prepare') return { ok: true, dir: 'C:\\tmp\\quote-ask\\workspace' }
        if (endpoint === 'append-quote') return { ok: true, quoteCount: 2 }
        if (endpoint === 'remove-quote') return { ok: true, quoteCount: 1 }
        if (endpoint === 'attach-main-quote') return { ok: true, quoteCount: 1 }
        if (endpoint === 'remove-main-quote') return { ok: true, quoteCount: 0 }
        if (endpoint === 'main-quotes-list') return { ok: true, quotes: [] }
        return { ok: true }
      },
    }
  }
  clientCtx.sessions = {
    async create(options) {
      calls.create.push(options)
      return childId
    },
    async using(sessionId, options, operation) {
      const reference = {
        ready: Promise.resolve(),
        binding: {
          session: {
            async command(line) {
              calls.commands.push({ sessionId, line })
              return { ok: true, value: { matched: true } }
            },
            async rename(title) {
              calls.renames.push({ sessionId, title })
              return { ok: true, value: {} }
            },
          },
        },
        release() {},
      }
      return operation(reference)
    },
    async refresh() {},
    list: {
      getSnapshot() {
        return { byId: { [MAIN_SESSION_ID]: { title: '测试主对话' } } }
      },
    },
  }
  clientCtx.sidebarRight.openResource = (address) => {
    calls.opens.push(address)
  }

  const sampleAnchor = {
    nodeKey: 'assistant-step:4:1',
    flowKind: 'assistant-step',
    turn: 3,
    charStart: 5,
    charEnd: 12,
    messageLength: 500,
    before: '前文',
    after: '后文',
    messageText: '完整消息文本',
  }
  await clientTest.openSideChat(clientCtx, '  引用片段\n第二行  ', sampleAnchor, MAIN_SESSION_ID)
  assert.equal(calls.create.length, 1, 'one blank session created')
  assert.equal(calls.create[0].cwd, 'C:\\tmp\\quote-ask\\workspace', 'session created in the scratch workspace')
  const prepareCall = calls.http.find((call) => call.endpoint === 'prepare')
  assert.ok(prepareCall && prepareCall.body.mainSessionId === MAIN_SESSION_ID, 'prepare names the main conversation')
  assert.ok(prepareCall.body.quote.includes('引用片段'), 'prepare carries the selected excerpt')
  assert.equal(prepareCall.body.anchor.nodeKey, sampleAnchor.nodeKey, 'prepare carries the exact DOM anchor')
  assert.equal(prepareCall.body.anchor.charStart, 5, 'prepare carries the exact character offset')
  const bindCall = calls.http.find((call) => call.endpoint === 'bind')
  assert.ok(bindCall && bindCall.body.sessionId === childId, 'bind uses the created session id')
  assert.equal(calls.opens.length, 1, 'tab opened')
  assert.ok(calls.opens[0].endsWith(childId), 'tab address targets the created session')
  assert.equal(calls.renames[0].title, '侧聊 · 测试主对话', 'session renamed with the main title')
  assert.equal(calls.commands.length, 0, 'no permission command needed')
  const sessionStore = JSON.parse(globalThis.window.localStorage.getItem('dsh-quote-ask.sessions.v1'))
  assert.ok(sessionStore[childId] && sessionStore[childId].sideChatId, 'side chat mapped to the session')
  assert.deepEqual(sessionStore[childId].quotes.map((item) => item.text), ['引用片段\n第二行'], 'initial quote stored for the chip')
  assert.equal(sessionStore[childId].quotes[0].anchor.nodeKey, sampleAnchor.nodeKey, 'initial quote anchor stored')
  assert.equal(sessionStore[childId].mainSessionId, MAIN_SESSION_ID, 'main conversation id stored for later appends')
  assert.equal(sessionStore[childId].mainTitle, '测试主对话', 'main title stored')
  assert.equal(globalThis.window.localStorage.getItem('dsh.conversation.' + childId), null, 'no composer draft created')

  // Appending another selection from the same main conversation updates the
  // stored quotes and calls the Host to regenerate the model-only context.
  const appendedCount = await clientTest.appendQuoteToSideChat(
    clientCtx,
    childId,
    sessionStore[childId].sideChatId,
    '第二条引用',
    { nodeKey: 'assistant-step:5:1', flowKind: 'assistant-step', turn: 4, charStart: 1, charEnd: 6 },
  )
  assert.equal(appendedCount, 2, 'append returns the new quote count')
  const appendCall = calls.http.filter((call) => call.endpoint === 'append-quote').pop()
  assert.ok(appendCall && appendCall.body.quote === '第二条引用', 'append-quote request carries the new excerpt')
  const storeAfterAppend = JSON.parse(globalThis.window.localStorage.getItem('dsh-quote-ask.sessions.v1'))
  assert.deepEqual(storeAfterAppend[childId].quotes.map((item) => item.text), ['引用片段\n第二行', '第二条引用'], 'both quotes kept for the chip')
  assert.equal(storeAfterAppend[childId].quotes[1].anchor.nodeKey, 'assistant-step:5:1', 'appended quote anchor stored')

  const removedCount = await clientTest.removeQuoteFromSideChat(
    clientCtx,
    childId,
    storeAfterAppend[childId].sideChatId,
    '第二条引用',
    { nodeKey: 'assistant-step:5:1', flowKind: 'assistant-step', turn: 4, charStart: 1, charEnd: 6 },
  )
  assert.equal(removedCount, 1, 'remove returns the remaining quote count')
  const removeCall = calls.http.filter((call) => call.endpoint === 'remove-quote').pop()
  assert.ok(removeCall && removeCall.body.quote === '第二条引用', 'remove-quote request carries the deleted excerpt')
  assert.equal(removeCall.body.quotes, undefined, 'remove does not resend the whole quote list')
  const storeAfterRemove = JSON.parse(globalThis.window.localStorage.getItem('dsh-quote-ask.sessions.v1'))
  assert.deepEqual(storeAfterRemove[childId].quotes.map((item) => item.text), ['引用片段\n第二行'], 'removed quote leaves the chip')

  // 9b) "添加至对话" stores main-conversation attachments for the next turn.
  const mainAdded = await clientTest.addQuoteToMainConversation(clientCtx, MAIN_SESSION_ID, '主对话引用', sampleAnchor)
  assert.equal(mainAdded, 1, 'main attachment count')
  const mainAttachCall = calls.http.filter((call) => call.endpoint === 'attach-main-quote').pop()
  assert.ok(mainAttachCall && mainAttachCall.body.mainSessionId === MAIN_SESSION_ID, 'attach-main-quote names the main session')
  assert.ok(mainAttachCall.body.quote === '主对话引用', 'attach-main-quote carries the excerpt')
  const mainStore = JSON.parse(globalThis.window.localStorage.getItem('dsh-quote-ask.main-quotes.v1'))
  assert.deepEqual(mainStore[MAIN_SESSION_ID].map((item) => item.text), ['主对话引用'], 'main attachment stored for the chip')
  const mainRemoved = await clientTest.removeMainQuoteFromConversation(clientCtx, MAIN_SESSION_ID, '主对话引用', sampleAnchor)
  assert.equal(mainRemoved, 0, 'main attachment removed')
  assert.equal(globalThis.window.localStorage.getItem('dsh-quote-ask.main-quotes.v1'), null, 'empty main attachment map removed')

  /* 10) A failed bind must abort and hand the created session to cleanup. */
  childId = 'session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  failEndpoint = 'bind'
  let rejectedOpen = null
  try {
    await clientTest.openSideChat(clientCtx, '另一个引用', null, MAIN_SESSION_ID)
  } catch (error) {
    rejectedOpen = error
  }
  assert.ok(rejectedOpen !== null, 'open aborts when bind fails')
  const cleanupCall = calls.http.filter((call) => call.endpoint === 'cleanup').pop()
  assert.ok(cleanupCall && cleanupCall.body.sessionId === childId, 'aborted session is handed to cleanup')
  const storeAfterFailure = JSON.parse(globalThis.window.localStorage.getItem('dsh-quote-ask.sessions.v1'))
  assert.equal(storeAfterFailure[childId], undefined, 'failed side chat is not kept in the session map')
  const pendingAfterFailure = JSON.parse(globalThis.window.localStorage.getItem('dsh-quote-ask.pending.v1') || '[]')
  assert.equal(pendingAfterFailure.length, 0, 'failed side chat cleanup is not queued')
  const graveyard = JSON.parse(globalThis.window.localStorage.getItem('dsh-quote-ask.graveyard.v1') || '[]')
  assert.equal(globalThis.window.localStorage.getItem('dsh.conversation.' + childId), null, 'aborted quote-ask draft scrubbed')
  assert.ok(Array.isArray(graveyard) && !graveyard.includes(childId), 'successful cleanup retires the draft retry record')

  console.log('ALL CHECKS PASSED')
  console.log('host warnings: ' + (logs.length === 0 ? '(none)' : logs.join(' | ')))
}

main().catch((error) => {
  console.error('TEST FAILED:', error && error.stack ? error.stack : error)
  process.exitCode = 1
})
