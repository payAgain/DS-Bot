import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { install } from '../src/host/approvals.js'
import { pendingReviewSources, reviewHome } from '../src/client/review-inbox-model.js'

const chief = { id: 'chief', sessionId: 'chief-part', name: 'Chief' }
const writer = { id: 'writer', sessionId: 'writer-part', name: 'Writer' }
const roster = { mainBotId: 'chief', bots: [chief, writer], byId: { chief, writer, 'chief-part': chief, 'writer-part': writer } }

const compiled = await build({
  stdin: { contents: "export { ExecutionReview, ReviewInboxDock, routeRequestDock } from './src/client/review-inbox.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
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


test('the Main Bot has an explicit empty-inbox status without claiming every host approval is covered', () => {
  const { ReviewInboxDock } = components()
  const tree = ReviewInboxDock({ sessionId: 'chief-part', useRoster: fn => fn(roster), actions: {} })
  assert.ok(JSON.stringify(tree).includes('No pending requests in this inbox.'))
  assert.equal(ReviewInboxDock({ sessionId: 'writer-part', useRoster: fn => fn(roster), actions: {} }), null)
})
