import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { install } from '../src/host/approvals.js'
import { pendingReviewSources, reviewHome, reviewForCall, waitingForReview } from '../src/client/review-inbox-model.js'

const chief = { id: 'chief', sessionId: 'chief-part', name: 'Chief' }
const writer = { id: 'writer', sessionId: 'writer-part', name: 'Writer' }
const roster = { mainBotId: 'chief', bots: [chief, writer], byId: { chief, writer, 'chief-part': chief, 'writer-part': writer } }

const compiled = await build({
  stdin: { contents: "export { ExecutionReview, ReviewInboxDock, routeRequestDock } from './src/client/review-inbox.js'; export { AppAccessCall, PendingAppAccess } from './src/client/computer.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
function components() {
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: 'fragment',
    Component: class {}, createContext: value => ({ value, Provider: 'Provider' }), useContext: ctx => ctx.value,
    useRef: current => ({ current }), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn, useId: () => 'test-id',
    useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
  const module = { exports: {} }
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, setTimeout, clearTimeout, queueMicrotask, URL,
    window: { matchMedia: () => ({ matches: false }) },
    require: name => name === 'react' ? react : name === 'react-dom' ? { createPortal: value => value } : {},
  })
  return module.exports
}
function all(node, match, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(value => all(value, match, out)); return out }
  if (match(node)) out.push(node)
  all(node.props?.children, match, out)
  return out
}
function host() {
  let handler
  const events = []
  const rt = { ctx: { on: (_name, fn) => { handler = fn } }, chatOwners: new Map([['writer-part', 'writer'], ['chief-part', 'chief']]), groupOwners: new Map(),
    callDetail: () => ({ text: 'Review this precise fixture operation', code: 'fixture operation --one' }), warn() {} }
  install(rt)
  rt.onApproval((kind, entry) => events.push({ kind, ...entry }))
  const ask = (extra = {}) => {
    const controller = new AbortController()
    const request = { agent: { session: { id: 'writer-part' } }, toolName: 'bash', reason: 'One-time sandbox request for a specific operation', signal: controller.signal, ...extra }
    const result = handler(request, () => new Promise(() => {}))
    return { controller, request, result }
  }
  return { rt, ask, events }
}

test('the Main Bot inbox collects original ids and source sessions without copying requests', () => {
  const data = { ...roster, questions: { 'writer-part': { id: 'question', callId: 'q' } }, views: { 'writer-part': { id: 'view' } },
    secretRequests: { writer: [{ id: 'secret', status: 'pending', name: 'FIXTURE_KEY' }] },
    connectorRequests: { writer: [{ id: 'connector', status: 'pending' }, { id: 'old', status: 'connected' }] },
    mailRequests: { writer: [{ id: 'mail', status: 'pending' }] }, learning: { writer: [{ id: 'proposal' }] } }
  const source = pendingReviewSources(data, { approvals: [{ id: 'approval', botId: 'writer' }] }, { writer: { callId: 'browser' } }, { asks: { a: { botId: 'writer' } }, holds: { writer: { callId: 'computer' } } })[0]
  assert.equal(reviewHome(data).id, 'chief')
  assert.equal(source.sessionId, 'writer-part')
  assert.equal(source.count, 10)
  assert.equal(source.secret[0].id, 'secret')
  assert.deepEqual(source.connector.map(item => item.id), ['connector'])
  const { ReviewInboxDock } = components()
  const tree = ReviewInboxDock({ sessionId: 'chief-part', useRoster: fn => fn(data), useWork: fn => fn({ approvals: [] }), actions: {} })
  assert.ok(JSON.stringify(tree).includes('data-source-bot'))
  assert.ok(!JSON.stringify(tree).includes('secret-set'), 'rendering must not execute an action')
})

test('a user click in the Main Bot card resumes the source exactly once and never allows another action', async () => {
  const { rt, ask, events } = host()
  const first = ask(), second = ask()
  const [one, two] = rt.approvalsView()
  assert.notEqual(one.id, two.id)
  const seen = []
  const { ExecutionReview } = components()
  const tree = ExecutionReview({ approval: one, actions: { answerApproval: (id, choice) => { seen.push([id, choice]); rt.answerApproval(id, choice) } } })
  const allow = all(tree, node => node.type === 'button').find(node => node.props.children.includes('Allow once'))
  allow.props.onClick(); allow.props.onClick()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(await first.result, 'allowed-once')
  assert.deepEqual(seen, [[one.id, 'allow']])
  assert.deepEqual(rt.approvalsView().map(entry => entry.id), [two.id])
  assert.throws(() => rt.answerApproval(one.id, 'allow'), /no longer open/)
  rt.answerApproval(two.id, 'reject')
  assert.equal(await second.result, 'rejected')
  assert.equal(events.filter(entry => entry.kind === 'settled' && entry.id === one.id).length, 1)
})

test('source cancellation withdraws the inbox card and stale approval cannot resume it', async () => {
  const { rt, ask } = host()
  const request = ask(), [entry] = rt.approvalsView()
  request.controller.abort()
  assert.equal(await request.result, 'cancelled')
  assert.deepEqual(rt.approvalsView(), [])
  assert.throws(() => rt.answerApproval(entry.id, 'allow'), /no longer open/)
})

test('truncated requests cannot be allowed by the inbox and unrelated sessions are not routed', () => {
  const { ExecutionReview, ReviewInboxDock, routeRequestDock } = components()
  const tree = ExecutionReview({ approval: { id: 'long', answerable: true, reasonTruncated: true, reason: 'Partial details' }, actions: {} })
  assert.equal(all(tree, node => node.type === 'button').find(node => node.props.children.includes('Allow once')).props.disabled, true)
  assert.equal(ReviewInboxDock({ sessionId: 'unowned-session', useRoster: fn => fn(roster), actions: {} }), null)
  const Original = () => 'original'
  assert.equal(routeRequestDock(Original)({ useRoster: fn => fn(roster) }), null)
})


test('an expired public approval signal resolves as cancelled without a user decision', async () => {
  const { rt, ask } = host()
  const pending = ask({ signal: AbortSignal.timeout(10) })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(await pending.result, 'cancelled')
  assert.deepEqual(rt.approvalsView(), [])
})


test('an empty inbox adds no permanent banner or empty source section', () => {
  const { ReviewInboxDock } = components()
  const tree = ReviewInboxDock({ sessionId: 'chief-part', useRoster: fn => fn(roster), actions: {} })
  assert.equal(tree, null)
  assert.equal(ReviewInboxDock({ sessionId: 'writer-part', useRoster: fn => fn(roster), actions: {} }), null)
})


const expand = node => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const appAsk = (id, bot = chief, extra = {}) => ({ id, botId: bot.id, sessionId: bot.sessionId, callId: `call-${id}`, appName: 'Finder', ...extra })
const inboxProps = (computer, extra = {}) => ({ sessionId: chief.sessionId, useRoster: fn => fn(roster), useComputer: fn => fn(computer), useCards: fn => fn({ [chief.sessionId]: { 'call-one': 1 } }), useHeldCards: fn => fn({}), actions: { computerAppAnswer() {} }, ...extra })

test('one application request has one interaction even when its own transcript call is drawn', () => {
  const { ReviewInboxDock, AppAccessCall } = components()
  const computer = { asks: { one: appAsk('one') } }
  const props = inboxProps(computer)
  const inline = expand(AppAccessCall({ sessionId: chief.sessionId, callId: 'call-one', roster, actions: props.actions, hooks: { useComputer: props.useComputer } }))
  const dock = expand(ReviewInboxDock(props))
  assert.equal(all([inline, dock], node => node.props?.['data-request-id'] === 'one').length, 1)
  assert.equal(all([inline, dock], node => node.type === 'button').length, 3)
  assert.ok(JSON.stringify(dock).includes('Allow access to Finder?'))
  assert.ok(JSON.stringify(dock).includes('This time: the requesting conversation part. Always: this Bot across conversations.'))
})

test('same-source and cross-source requests remain separate by original id, not app title', () => {
  const { ReviewInboxDock } = components()
  const computer = { asks: { one: appAsk('one'), alias: appAsk('one'), two: appAsk('two'), worker: appAsk('worker', writer) } }
  const tree = expand(ReviewInboxDock(inboxProps(computer)))
  assert.deepEqual(all(tree, node => node.props?.['data-request-id']).map(node => node.props['data-request-id']), ['one', 'two', 'worker'])
  assert.equal(pendingReviewSources(roster, {}, {}, computer).reduce((sum, source) => sum + source.count, 0), 3)
  assert.equal(all(tree, node => node.type === 'button').length, 9)
  assert.equal(all(tree, node => node.props?.className === 'bt-review-source').length, 2)
})

test('settlement and cancellation withdraw only their own request and never revive historical cards', () => {
  const { ReviewInboxDock, AppAccessCall } = components()
  const computer = { asks: { old: appAsk('old', chief, { status: 'cancelled' }), done: appAsk('done', chief, { outcome: 'once' }), live: appAsk('live') } }
  const props = inboxProps(computer)
  const tree = expand(ReviewInboxDock(props))
  assert.deepEqual(all(tree, node => node.props?.['data-request-id']).map(node => node.props['data-request-id']), ['live'])
  assert.equal(reviewForCall(roster, chief.sessionId, 'call-old', {}, computer), undefined)
  assert.equal(reviewForCall(roster, chief.sessionId, 'other-call', {}, computer), undefined)
  const history = expand(AppAccessCall({ sessionId: chief.sessionId, callId: 'call-old', roster, actions: props.actions, hooks: { useComputer: props.useComputer } }))
  assert.equal(all(history, node => node.type === 'button').length, 0)
  delete computer.asks.live
  assert.equal(ReviewInboxDock(props), null)
})

test('app-access answers keep original id and scope, suppress double clicks, and can retry a failure', async () => {
  const { PendingAppAccess } = components()
  for (const [label, choice] of [['Deny', 'deny'], ['This time', 'once'], ['Always', 'always']]) {
    const seen = []
    const tree = PendingAppAccess({ ask: appAsk('original'), actions: { computerAppAnswer: async (...args) => seen.push(args) }, inline: false, compact: true })
    const button = all(tree, node => node.type === 'button').find(node => node.props.children.includes(label))
    button.props.onClick(); button.props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(seen, [['original', choice]])
  }
  let attempts = 0
  const tree = PendingAppAccess({ ask: appAsk('retry'), actions: { computerAppAnswer: async () => { attempts++; if (attempts === 1) throw Error('offline') } } })
  const allow = all(tree, node => node.type === 'button').find(node => node.props.children.includes('This time'))
  allow.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  allow.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(attempts, 2)
})

test('waiting status follows live blocking requests, not other Bots or background suggestions', () => {
  assert.equal(waitingForReview(roster, chief.sessionId, {}, {}, { asks: { a: appAsk('a') } }), true)
  assert.equal(waitingForReview(roster, writer.sessionId, {}, {}, { asks: { a: appAsk('a') } }), false)
  assert.equal(waitingForReview(roster, chief.sessionId, { approvals: [{ id: 'a', botId: chief.id }] }), true)
  assert.equal(waitingForReview({ ...roster, learning: { chief: [{ id: 'background' }] } }, chief.sessionId), false)
  assert.equal(waitingForReview(roster, chief.sessionId, {}, {}, { asks: { a: appAsk('a', chief, { status: 'expired' }) } }), false)
})
