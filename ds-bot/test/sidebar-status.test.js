import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const { outputFiles } = await build({
  stdin: { contents: "export { TeamSidebar } from './src/client/sidebar.js'; export { installLocale, DICTIONARY } from './src/client/i18n.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: value => ({ value }), useContext: ctx => ctx.value, useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: value => [value, () => {}], useMemo: fn => fn(), useRef: current => ({ current }), useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : {}, window: { innerWidth: 1280 } })
const { TeamSidebar, installLocale, DICTIONARY } = module.exports
const flatten = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node)
  : Array.isArray(node) ? node.map(flatten).join('') : flatten(node.props?.children)
const expand = node => !node || typeof node !== 'object' ? node : Array.isArray(node) ? node.map(expand)
  : typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props.children) } }
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
  return predicate(node) ? node : find(node.props?.children, predicate)
}
function row({ running = false, activity, work = {}, questions = {}, views = {}, tile = false } = {}) {
  const bot = { id: 'writer', name: 'Writer', role: 'Old role', createdAt: 1 }
  const room = { id: 'team', name: 'Team', members: ['writer'], createdAt: 2 }
  const roster = { bots: [bot], rooms: [room], agents: [], byId: { writer: bot, reviewer: { name: 'Reviewer' } }, roomsById: { team: room }, ready: true, exchangeTurns: {}, questions, views, ...(tile ? { mainBotId: 'writer', mainBotIds: ['writer'] } : {}) }
  const actions = Object.fromEntries(['openSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread'].map(name => [name, () => {}]))
  const tree = TeamSidebar({ actions, useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map([['writer', { running }]])), useSessionRetainInfo: () => null,
    useActivity: pick => pick({ writer: activity }), useWork: pick => pick(work),
  })
  const component = find(tree, node => node.type?.name === 'BotRow')
  // A Bot row must not subscribe to or read message history for its secondary line.
  const rendered = expand(component.type({ ...component.props, useSessions: () => { throw Error('Historical preview read') } }))
  const status = find(rendered, node => node.props?.className === 'bt-row-preview')
  return { rendered, text: flatten(status) }
}

test('idle rows show Idle without reading message history, including the Main Bot tile', () => {
  assert.equal(row().text, 'Idle')
  const tile = row({ tile: true })
  assert.equal(tile.text, 'Idle')
  assert.doesNotMatch(flatten(tile.rendered), /Old role/)
})
test('a running row uses detailed live work instead of the activity category', () => {
  assert.equal(row({ running: true, activity: 'working', work: { bots: { writer: { tool: 'bash', note: 'Run source checks' } } } }).text, 'Run source checks…')
  assert.equal(row({ running: true }).text, 'Thinking about it…')
})
test('live host work covers a still-loading Session and stale activity alone cannot invent work', () => {
  assert.equal(row({ activity: 'working' }).text, 'Idle')
  assert.equal(row({ work: { bots: { writer: { tool: 'read', target: 'fixture.js' } } } }).text, 'Opening a file · fixture.js…')
})
test('group work retains its group and specific doing', () => {
  assert.equal(row({ work: { rooms: { team: [{ botId: 'writer', note: 'Review changes' }] } } }).text, 'Team · Review changes…')
})
test('handoff waits use real dependencies even without a matching activity frame', () => {
  assert.equal(row({ work: { waiting: { writer: { bots: ['reviewer'] } } } }).text, 'Waiting for Reviewer')
  assert.equal(row({ work: { waiting: { writer: { rooms: ['team'] } } } }).text, 'Waiting for Team')
})
test('pending approvals and answer cards take priority, settled cards do not', () => {
  const active = { running: true, work: { approvals: [{ botId: 'writer', status: 'pending' }] } }
  assert.equal(row(active).text, 'Waiting for your approval')
  assert.equal(row({ running: true, questions: { writer: { id: 'question' } } }).text, 'Waiting for your answer')
  assert.equal(row({ views: { writer: { id: 'view' } } }).text, 'Waiting for your answer')
  assert.equal(row({ questions: { writer: { outcome: 'answered' } }, work: { approvals: [{ botId: 'writer', status: 'resolved' }] } }).text, 'Idle')
})
test('live execution takes priority over a separate handoff wait', () => {
  assert.equal(row({ running: true, work: { bots: { writer: { note: 'Check files' } }, waiting: { writer: { bots: ['reviewer'] } } } }).text, 'Check files…')
})
test('Idle is localized through the existing dictionary', () => {
  const off = installLocale({ register() {}, bind: () => key => DICTIONARY.zh[key] ?? key })
  try { assert.equal(row().text, '空闲') } finally { off() }
})
