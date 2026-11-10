import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const compiled = await build({ stdin: { contents: "export { ConnectorsPage, AppConnectionsEntry } from './src/client/connectors-page.js'; export { ConnectedAppsPanel, ConnectedAppAccount } from './src/client/connected-apps.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
function fixture() {
  const slots = []; let index = 0
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: 'fragment', Component: class {},
    createContext: value => ({ value, Provider: 'Provider' }), useContext: value => value.value,
    useEffect() {}, useLayoutEffect() {}, useId: () => 'account-controls', useMemo: make => make(), useCallback: fn => fn,
    useState: initial => { const at = index++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
      return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }] },
    useRef: current => { const at = index++; return slots[at] ??= { current } }, useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
  const module = { exports: {} }
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, URL, setTimeout, clearTimeout, window: { matchMedia: () => ({ matches: false }) },
    require: name => name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {} })
  return { ...module.exports, render(Component, props) { index = 0; return Component(props) } }
}
function nodes(node, match, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(item => nodes(item, match, out)); return out }
  if (match(node)) out.push(node)
  nodes(node.props?.children, match, out); return out
}
const text = node => !node ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children)
const button = (tree, label) => nodes(tree, node => node.type === 'button' && text(node) === label)[0]
const account = { id: 'fixture-account', toolkit: 'gmail', label: 'Personal Gmail', status: 'ACTIVE', enabled: true, bots: ['chief', 'mail'], revision: 1 }
const bots = [{ id: 'chief', name: 'Chief' }, { id: 'mail', name: 'Mail helper' }, { id: 'other', name: 'Other Bot' }]

test('the main connector page contains one module entry and no embedded account/catalog form', () => {
  const f = fixture(), calls = []
  const props = { roster: { bots, connectors: { connectors: [], mail: { accounts: [{ address: 'fixture@qq.test', provider: 'qq' }] } }, connectedApps: { accounts: [account] } }, actions: { connectedApps: (...args) => calls.push(args) } }
  let tree = f.render(f.ConnectorsPage, props)
  assert.equal(nodes(tree, node => node.type === f.ConnectedAppsPanel).length, 0)
  const entry = nodes(tree, node => node.type === f.AppConnectionsEntry)
  assert.equal(entry.length, 1)
  entry[0].props.onOpen()
  tree = f.render(f.ConnectorsPage, props)
  const library = nodes(tree, node => node.type === f.ConnectedAppsPanel)
  assert.equal(library.length, 1)
  assert.ok(!library[0].props.configuration)
  button(tree, 'Connection settings').props.onClick()
  tree = f.render(f.ConnectorsPage, props)
  assert.equal(nodes(tree, node => node.type === f.ConnectedAppsPanel)[0].props.configuration, true)
  assert.deepEqual(calls, [], 'navigation must not connect, disconnect or change account policy')
})

test('a collapsed account shows only a compact summary, with no raw id, policy form or destructive controls', () => {
  const f = fixture()
  const tree = f.render(f.ConnectedAppAccount, { account, bots })
  assert.ok(text(tree).includes('Personal Gmail'))
  assert.ok(text(tree).includes('Chief, Mail helper'))
  assert.equal(nodes(tree, node => node.type === 'input').length, 0)
  assert.ok(!text(tree).includes(account.id))
  assert.ok(button(tree, 'Manage'))
  assert.equal(button(tree, 'Disconnect'), undefined)
})

test('opening management preserves saved grants; editing remains explicit and isolated until Save access', () => {
  const f = fixture(), saved = [], disconnected = []
  const props = { account, bots, save: value => saved.push(value), disconnect: id => disconnected.push(id) }
  let tree = f.render(f.ConnectedAppAccount, props)
  button(tree, 'Manage').props.onClick(); tree = f.render(f.ConnectedAppAccount, props)
  let inputs = nodes(tree, node => node.type === 'input')
  assert.deepEqual(inputs.map(input => input.props.checked), [true, true, true, false])
  assert.ok(text(tree).includes(account.id))
  inputs[3].props.onChange(); tree = f.render(f.ConnectedAppAccount, props)
  assert.deepEqual(saved, [])
  button(tree, 'Save access').props.onClick()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].id, account.id)
  assert.equal(saved[0].enabled, true)
  assert.deepEqual([...saved[0].bots], ['chief', 'mail', 'other'])
  assert.deepEqual(account.bots, ['chief', 'mail'], 'rendering must not mutate the saved account')
  button(tree, 'Disconnect').props.onClick(); tree = f.render(f.ConnectedAppAccount, props)
  assert.deepEqual(disconnected, [], 'Disconnect must still require explicit confirmation')
  assert.ok(button(tree, 'Confirm disconnect'))
})

test('the compact module entry carries search intent without starting an authorization', () => {
  const f = fixture(); let opened = 0
  const tree = f.render(f.AppConnectionsEntry, { accounts: [account], query: 'Twitter', onOpen: () => opened++ })
  assert.ok(text(tree).includes('Search Twitter in the app library'))
  button(tree, 'Open').props.onClick()
  assert.equal(opened, 1)
})
