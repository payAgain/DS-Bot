import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { PNG } from 'pngjs'
import { PUSH_WORKER_SOURCE, pushIcon, pushManifest } from '../src/host/web-push-resources.js'

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/client/web-push.js', import.meta.url))], bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'] })

function worker() {
  const handlers = new Map(), shown = [], opened = []
  let windows = []
  const self = { location: { origin: 'https://gateway.test' }, addEventListener: (kind, fn) => handlers.set(kind, fn), skipWaiting: async () => {}, registration: { showNotification: async (...args) => shown.push(args) }, clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async url => opened.push(url) } }
  runInNewContext(PUSH_WORKER_SOURCE, { self, URL, fetch: () => { throw new Error('worker must not fetch') } })
  const dispatch = async (kind, extra) => { let pending; handlers.get(kind)({ ...extra, waitUntil: task => { pending = task } }); await pending }
  return { handlers, shown, opened, dispatch, setWindows: value => { windows = value } }
}
test('worker displays a self-contained generic notification without fetching the private Mac', async () => {
  const w = worker(); await w.dispatch('push', { data: { json: () => ({ kind: 'approval', language: 'zh', target: 'bot-fixture', tag: 'event-1', body: 'private fixture text must not appear', url: 'https://evil.test' }) } })
  assert.equal(w.shown[0][0], 'DS Bot'); assert.equal(w.shown[0][1].body, '有请求需要你审批，点击查看。'); assert.equal(w.shown[0][1].data.target, 'bot-fixture'); assert.equal(JSON.stringify(w.shown).includes('private fixture'), false); assert.equal(w.handlers.has('fetch'), false); assert.equal(w.shown[0][1].renotify, false)
})
test('notification click reuses only a same-origin home window, with a validated conversation id', async () => {
  const w = worker(), moved = []; let focused = 0
  w.setWindows([{ url: 'https://evil.test/', navigate: () => { throw new Error('wrong origin') } }, { url: 'https://gateway.test/other-app', navigate: () => { throw new Error('other app') } }, { url: 'https://gateway.test/', navigate: async url => { moved.push(url); return { focus: async () => { focused += 1 } } } }])
  await w.dispatch('notificationclick', { notification: { close() {}, data: { target: 'bot-fixture', url: 'https://evil.test' } } })
  assert.equal(focused, 1); assert.equal(moved[0], 'https://gateway.test/?dsbot-pwa=1&dsbot-push=bot-fixture'); assert.equal(w.opened.length, 0)
  w.setWindows([]); await w.dispatch('notificationclick', { notification: { close() {}, data: { target: '//evil.test' } } }); assert.equal(w.opened[0], 'https://gateway.test/?dsbot-pwa=1')
})
test('malformed push still produces a generic visible notification, never an arbitrary destination', async () => {
  const w = worker(); await w.dispatch('push', { data: { json() { throw new Error('bad fixture JSON') } } }); assert.equal(w.shown[0][1].body, 'A conversation has a new reply.'); assert.equal(w.shown[0][1].data.target, '')
})
test('PWA manifest and original generated icons have fixed same-origin scope and sizes', () => {
  const manifest = pushManifest(); assert.equal(manifest.start_url, '/?dsbot-pwa=1'); assert.equal(manifest.scope, '/'); assert.equal(manifest.display, 'standalone')
  for (const size of [192, 512]) { const png = PNG.sync.read(pushIcon(size)); assert.equal(png.width, size); assert.equal(png.height, size); assert.ok(manifest.icons.some(icon => icon.sizes === `${size}x${size}`)) }
})

function client(overrides = {}) {
  const states = [], effects = [], actions = [], requests = [], registrations = []
  const storage = new Map(); let cursor = 0, permissionCalls = 0
  const registration = { scope: 'https://gateway.test/', active: { scriptURL: 'https://gateway.test/api/bot/web-push-worker.js' }, pushManager: { getSubscription: async () => null, subscribe: async () => ({ toJSON: () => ({ endpoint: 'fixture subscription opaque data' }) }) }, unregister: async () => true }
  const env = { module: { exports: {} }, exports: {}, URL, Uint8Array, atob, setTimeout, clearTimeout,
    location: { href: 'https://gateway.test/', origin: 'https://gateway.test' }, history: { state: null, replaceState: (...args) => actions.push(['replace', ...args]) }, document: { querySelector: () => null },
    navigator: { userAgent: 'Chromium fixture', language: 'en', serviceWorker: { getRegistrations: async () => registrations, register: async () => { registrations.push(registration); return registration } } },
    isSecureContext: true, PushManager: function PushManager() {}, Notification: { permission: 'default', requestPermission: () => { permissionCalls += 1; return Promise.resolve('granted') } }, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fetch: async (_url, request = {}) => { requests.push(request); const body = request.body ? JSON.parse(request.body) : null; return { ok: true, json: async () => ({ ok: true, publicKey: Buffer.alloc(65, 1).toString('base64url'), csrf: 'fixture-csrf', subscribed: body?.action === 'subscribe', includePrivate: false }) } },
    require: () => ({ createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] }, useRef: initial => { const index = cursor++; return states[index] ??= { current: initial } }, useEffect: run => { const index = cursor++; if (!(index in states)) { states[index] = true; effects.push(run) } } }),
    ...overrides,
  }
  env.exports = env.module.exports; runInNewContext(bundle.outputFiles[0].text, env)
  const api = env.module.exports
  return { env, api, actions, requests, registrations, registration, permissionCalls: () => permissionCalls,
    render: () => { cursor = 0; const view = api.WebPushSettings(); for (const run of effects.splice(0)) run(); return view },
    flush: async () => { for (let n = 0; n < 5; n += 1) await new Promise(resolve => setImmediate(resolve)) },
  }
}
function find(node, text) { if (!node || typeof node !== 'object') return undefined; if (node.type === 'button' && node.children.includes(text)) return node; return node.children?.map(child => find(child, text)).find(Boolean) }
test('ordinary iOS requires Home Screen first and never requests permission on mount', async () => {
  const c = client(); c.env.navigator.userAgent = 'iPhone'; c.render(); await c.flush(); const view = c.render(); assert.equal(c.permissionCalls(), 0); assert.equal(c.registrations.length, 0); assert.equal(find(view, 'Enable on this device').props.disabled, true)
  assert.equal(c.api.pushSupport({ isSecureContext: true, navigator: { userAgent: 'iPhone', standalone: true, serviceWorker: {} }, PushManager: {}, Notification: { permission: 'denied' } }).standalone, true)
})
test('permission starts only in explicit subscribe gesture, and double-click does not prompt twice', async () => {
  const c = client(); c.render(); await c.flush(); const view = c.render(), button = find(view, 'Enable on this device'); assert.equal(c.permissionCalls(), 0); assert.equal(button.props.disabled, false)
  button.props.onClick(); button.props.onClick(); assert.equal(c.permissionCalls(), 1); await c.flush(); assert.equal(c.requests.filter(request => request.method === 'POST' && JSON.parse(request.body).action === 'subscribe').length, 1)
})
test('denied permission disables subscription without retrying or changing system settings', async () => {
  const c = client(); c.env.Notification.permission = 'denied'; c.render(); await c.flush(); const view = c.render(); assert.equal(find(view, 'Enable on this device').props.disabled, true); assert.equal(c.permissionCalls(), 0)
})
test('an existing different root worker is preserved, and more-specific workers are not unregistered', async () => {
  const c = client(); c.registrations.push({ scope: 'https://gateway.test/', active: { scriptURL: 'https://gateway.test/other-worker.js' } }); await assert.rejects(c.api.preparePushWorker(), /worker-conflict/); assert.equal(c.registrations.length, 1)
  c.registrations.length = 0; c.registrations.push({ scope: 'https://gateway.test/other-app/', active: { scriptURL: 'https://gateway.test/other-worker.js' } }); assert.equal(await c.api.preparePushWorker(), c.registration); assert.equal(c.registrations.length, 2)
})
test('ordinary entry preserves the host manifest, and an unknown manifest is never overwritten', () => {
  const c = client(); const existing = { href: 'https://gateway.test/custom.webmanifest' }; let changes = 0
  const doc = { querySelector: () => existing, createElement: () => { changes += 1; throw new Error('must not replace another manifest') } }
  const roster = { getSnapshot: () => ({ ready: true, byId: {}, roomsById: {} }) }
  const actions = { openSession() {}, openSettings() {} }
  c.api.installPushEntry({ roster, actions, document: doc, location: c.env.location, history: c.env.history })
  c.api.installPushEntry({ roster, actions, document: doc, location: { ...c.env.location, href: 'https://gateway.test/?dsbot-pwa=1' }, history: c.env.history })
  assert.equal(existing.href, 'https://gateway.test/custom.webmanifest'); assert.equal(changes, 0); assert.equal(c.permissionCalls(), 0)
})

test('a reset device cookie can still unsubscribe its own browser-local subscription', async () => {
  const c = client(); let removed = 0
  c.registration.pushManager.getSubscription = async () => ({ unsubscribe: async () => { removed += 1 } })
  c.render(); await c.flush(); const view = c.render(); const button = find(view, 'Unsubscribe this device')
  assert.equal(button.props.disabled, false); await button.props.onClick(); await c.flush(); assert.equal(removed, 1); assert.equal(c.permissionCalls(), 0)
})
test('deep links resolve only an actually visible roster target and consume no external URL', async () => {
  const c = client(), opened = [], toasts = []; c.env.location.href = 'https://gateway.test/?dsbot-pwa=0&dsbot-push=bot-fixture'
  c.api.installPushEntry({ roster: { getSnapshot: () => ({ ready: true, byId: { 'bot-fixture': {} }, roomsById: {} }) }, actions: { openSession: id => opened.push(id), reportError: error => toasts.push(error.message) }, document: c.env.document, location: c.env.location, history: c.env.history }); assert.deepEqual(opened, ['bot-fixture'])
  c.env.location.href = 'https://gateway.test/?dsbot-push=https%3A%2F%2Fevil.test'; c.api.installPushEntry({ roster: { getSnapshot: () => ({ ready: true, byId: {}, roomsById: {} }) }, actions: { openSession: () => { throw new Error('unknown destination') }, reportError: error => toasts.push(error.message) }, document: c.env.document, location: c.env.location, history: c.env.history }); assert.equal(toasts.length, 1)
})
