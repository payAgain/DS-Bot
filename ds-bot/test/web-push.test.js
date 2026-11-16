import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile, symlink, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import webpush from 'web-push'
import { WebPushStore } from '../src/host/web-push-store.js'
import { validatePushSubscription, publicPushAddress } from '../src/host/web-push-policy.js'
import { install, requirePushOrigin } from '../src/host/web-push.js'

const subscription = (suffix = 'fixture') => { const ec = createECDH('prime256v1'); ec.generateKeys(); return { endpoint: `https://web.push.apple.com/${suffix}`, keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } } }
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-push-'))
  const sent = []
  const store = await new WebPushStore({ directory, writable: () => true, targetAllowed: () => true, send: async (sub, payload, config) => { sent.push({ sub, payload: JSON.parse(payload), config }); return { statusCode: 201 } }, ...options }).init()
  t.after(async () => { await store.stop(); assert.ok(directory.startsWith(join(tmpdir(), 'ds-bot-push-'))); await rm(directory, { recursive: true, force: true }) })
  return { directory, store, sent }
}
async function settle(store) { for (let n = 0; n < 4; n += 1) { await new Promise(resolve => setImmediate(resolve)); await store.serial; await store.running } }

test('VAPID and encrypted subscriptions persist privately, while status exposes no key material', async t => {
  const { directory, store } = await fixture(t)
  const sub = subscription(); await store.subscribe('owner', sub)
  const first = await readFile(join(directory, 'vapid.json'), 'utf8')
  const second = await new WebPushStore({ directory, writable: () => true, targetAllowed: () => true, send: async () => ({ statusCode: 201 }) }).init()
  assert.ok(second.keys.privateKey === store.keys.privateKey)
  assert.ok(second.data.devices.owner.subscription.endpoint === sub.endpoint); assert.ok(second.data.devices.owner.subscription.keys.p256dh === sub.keys.p256dh); assert.ok(second.data.devices.owner.subscription.keys.auth === sub.keys.auth)
  assert.ok(await readFile(join(directory, 'vapid.json'), 'utf8') === first)
  if (process.platform !== 'win32') { assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(join(directory, 'vapid.json'))).mode & 0o777, 0o600); assert.equal((await stat(join(directory, 'devices.json'))).mode & 0o777, 0o600) }
  assert.equal(JSON.stringify(second.status('owner')).includes(sub.endpoint), false)
  assert.equal(JSON.stringify(second.status('owner')).includes(sub.keys.auth), false)
  assert.equal(second.status('other').subscribed, false)
  await second.stop()
})
test('subscriptions reject hostile endpoints, ports, credentials and malformed public keys', () => {
  const good = subscription()
  for (const endpoint of ['http://web.push.apple.com/fixture', 'https://127.0.0.1/fixture', 'https://web.push.apple.com.attacker.test/fixture', 'https://evil@web.push.apple.com/fixture', 'https://web.push.apple.com:8443/fixture', 'https://web.push.apple.com/fixture#x', 'https://fcm.googleapis.com/not-push']) assert.throws(() => validatePushSubscription({ ...good, endpoint }))
  assert.throws(() => validatePushSubscription({ ...good, keys: { ...good.keys, auth: 'short' } }))
  assert.throws(() => validatePushSubscription({ ...good, keys: { ...good.keys, p256dh: Buffer.alloc(65).toString('base64url') } }))
  assert.equal(validatePushSubscription(good).endpoint, good.endpoint)
  for (const ip of ['127.0.0.1', '10.0.0.2', '100.64.0.1', '169.254.169.254', '172.16.0.2', '192.168.0.1', '198.18.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(publicPushAddress(ip), false)
  assert.equal(publicPushAddress('8.8.8.8'), true)
  assert.equal(publicPushAddress('2606:4700:4700::1111'), true)
})
test('endpoint takeover, cross-device unsubscribe and unbounded device creation are refused', async t => {
  const { store } = await fixture(t); const sub = subscription(); await store.subscribe('a', sub)
  await assert.rejects(store.subscribe('b', sub), { code: 'push/owned-elsewhere' })
  await store.unsubscribe('b'); assert.equal(store.status('a').subscribed, true)
  for (let n = 1; n < 32; n += 1) await store.subscribe('owner-' + n, subscription('fixture-' + n))
  await assert.rejects(store.subscribe('overflow', subscription('overflow')), { code: 'push/device-limit' })
})
test('one true event sends a generic encrypted-payload input once, including after restart', async t => {
  const { store, sent, directory } = await fixture(t); await store.subscribe('a', subscription(), { language: 'zh' })
  await store.emit('turn:fixture:1', 'reply', 'bot-fixture'); await settle(store)
  assert.equal(sent.length, 1); assert.equal(sent[0].payload.kind, 'reply'); assert.equal(sent[0].payload.target, 'bot-fixture'); assert.equal(sent[0].payload.language, 'zh')
  assert.equal(sent[0].config.timeout, 7000); assert.equal(sent[0].config.TTL, 3600)
  assert.deepEqual(Object.keys(sent[0].payload).sort(), ['kind', 'language', 'tag', 'target'])
  const details = webpush.generateRequestDetails(sent[0].sub, JSON.stringify(sent[0].payload), { vapidDetails: sent[0].config.vapidDetails, TTL: 300 })
  assert.ok(details.body.length > 0); assert.ok(details.headers.Authorization || details.headers.authorization)
  await store.emit('turn:fixture:1', 'reply', 'bot-fixture'); await settle(store); assert.equal(sent.length, 1)
  await store.stop(); const resumed = await new WebPushStore({ directory, writable: () => true, targetAllowed: () => true, send: async () => { throw new Error('must not repeat') } }).init()
  await resumed.emit('turn:fixture:1', 'reply', 'bot-fixture'); await settle(resumed); assert.equal(resumed.data.queue.length, 0); await resumed.stop()
})
test('private sources and later visibility changes are checked again before sending', async t => {
  let allowed = true; const { store, sent } = await fixture(t, { targetAllowed: () => allowed })
  await store.subscribe('a', subscription()); await store.emit('private:1', 'approval', 'bot-private', true); await settle(store); assert.equal(sent.length, 0)
  await store.subscribe('a', subscription('enabled'), { includePrivate: true }); await store.emit('private:2', 'approval', 'bot-private', true); await settle(store); assert.equal(sent.length, 1)
  allowed = false; await store.emit('private:3', 'reply', 'bot-private'); await settle(store); assert.equal(sent.length, 1)
})
test('404/410 remove only the expired owned subscription', async t => {
  for (const statusCode of [404, 410]) {
    const { store } = await fixture(t, { send: async () => { throw { statusCode } } }); await store.subscribe('a', subscription()); await store.emit('gone', 'reply', 'bot'); await settle(store); assert.equal(store.status('a').subscribed, false)
  }
})
test('unknown transport outcomes are not retried and interrupted in-flight work is not replayed', async t => {
  let attempts = 0; const { store } = await fixture(t, { send: async () => { attempts += 1; throw new Error('fixture transport failure') } }); await store.subscribe('a', subscription()); await store.emit('unknown', 'reply', 'bot'); await settle(store); assert.equal(attempts, 1)
  store.data.queue.push({ id: 'interrupted', owner: 'a', target: 'bot', kind: 'reply', state: 'sending', attempts: 1, expires: Date.now() + 60000 }); await store.save(); await store.stop()
  const resumed = await new WebPushStore({ directory: store.directory, writable: () => true, targetAllowed: () => true, send: async () => { throw new Error('in-flight replay') } }).init(); assert.equal(resumed.data.queue.length, 0); await resumed.stop()
})
test('only explicit transient rejections may queue a bounded retry; tests are rate-limited', async t => {
  const { store } = await fixture(t, { send: async () => { throw { statusCode: 503 } } }); await store.subscribe('a', subscription()); await store.emit('busy', 'reply', 'bot'); await settle(store)
  assert.equal(store.data.queue[0].state, 'queued'); assert.equal(store.data.queue[0].attempts, 1)
  await store.test('a'); await assert.rejects(store.test('a'), { code: 'push/rate-limit' }); await store.unsubscribe('a'); assert.equal(store.data.queue.length, 0)
})
test('queue capacity is bounded and explicit rejection retries stop after three attempts', async t => {
  let now = Date.now(), attempts = 0
  const { store } = await fixture(t, { now: () => now, send: async () => { attempts += 1; throw { statusCode: 503 } } })
  await store.subscribe('a', subscription()); await store.emit('bounded-retry', 'reply', 'bot'); await settle(store)
  for (let n = 0; n < 2; n += 1) { now += 10000; store.drain(); await settle(store) }
  assert.equal(attempts, 3); assert.equal(store.data.queue.length, 0)
  store.active = true
  for (let n = 0; n < 80; n += 1) await store.emit('queued-' + n, 'reply', 'bot')
  assert.equal(store.data.queue.length, 64)
  await assert.rejects(store.test('a'), { code: 'push/queue-limit' })
  store.active = false
})
test('an unresolved transport is bounded by a deadline and left unknown without a resend', async t => {
  let attempts = 0; const { store } = await fixture(t, { send: () => { attempts += 1; return new Promise(() => {}) } })
  await store.subscribe('a', subscription()); await store.test('a'); await settle(store)
  assert.equal(attempts, 1); assert.equal(store.status('a').lastTest.state, 'unknown'); assert.equal(store.data.queue.length, 0)
})

test('corrupt stores fail closed and never rotate a stored key silently', async t => {
  const { store, directory } = await fixture(t); const key = store.keys.privateKey; await store.stop(); await writeFile(join(directory, 'devices.json'), '{broken', { mode: 0o600 })
  const broken = new WebPushStore({ directory, writable: () => true, targetAllowed: () => true }); await assert.rejects(broken.init()); assert.ok(JSON.parse(await readFile(join(directory, 'vapid.json'), 'utf8')).privateKey === key); await broken.stop()
})
test('a missing saved VAPID key does not silently replace subscribed device identity', async t => {
  const { store, directory } = await fixture(t); await store.subscribe('a', subscription()); await store.stop()
  const path = join(directory, 'vapid.json'); assert.equal(dirname(path), directory); await rm(path)
  const resumed = new WebPushStore({ directory, writable: () => true, targetAllowed: () => true }); await assert.rejects(resumed.init(), { code: 'push/storage' }); await resumed.stop()
})
test('a linked key file fails closed without chmod of its target', { skip: process.platform === 'win32' }, async t => {
  const { store, directory } = await fixture(t); await store.stop()
  const original = join(directory, 'vapid.json'), other = join(directory, 'unrelated-fixture.json')
  await writeFile(other, JSON.stringify(store.keys), { mode: 0o644 }); await chmod(other, 0o644)
  assert.equal(dirname(original), directory); await rm(original); await symlink(other, original)
  const linked = new WebPushStore({ directory, writable: () => true, targetAllowed: () => true }); await assert.rejects(linked.init(), { code: 'push/storage' }); await linked.stop()
  assert.equal((await stat(other)).mode & 0o777, 0o644)
})
test('cross-site JSON mutations fail and CSRF is bound to a device secret', async t => {
  const { store } = await fixture(t); const token = store.csrf('device-a'); assert.equal(store.checkCsrf('device-a', token), true); assert.equal(store.checkCsrf('device-b', token), false)
  const req = headers => new Request('https://gateway.test/api/bot/web-push', { headers: { host: 'gateway.test', 'content-type': 'application/json', ...headers } })
  requirePushOrigin(req({ origin: 'https://gateway.test' }))
  for (const headers of [{}, { origin: 'null' }, { origin: 'https://evil.test' }, { origin: 'https://gateway.test', 'sec-fetch-site': 'cross-site' }, { origin: 'https://gateway.test', 'content-type': 'text/plain' }]) assert.throws(() => requirePushOrigin(req(headers)))
})

test('actual Host routes enforce owned cookies/CSRF and map final, report, pending and failure events', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-push-')); const routes = new Map(), listeners = new Map(), disposers = []; let saved, approval, store; const sent = []
  let waiting = {}
  const bots = { b: { id: 'b' }, p: { id: 'p', private: true } }, state = { mainBotIds: ['b'], questions: {}, views: {}, exchangeTurns: {} }
  const rt = { home, state, waitingView: () => waiting, load: async () => {}, readOnly: () => undefined, botOf: id => bots[id], roomOf: () => undefined, approvalsView: () => [], onSaved: fn => { saved = fn; return () => {} }, onApproval: fn => { approval = fn; return () => {} }, chatOwners: new Map([['part', 'b']]), groupOwners: new Map(), ctx: {
    on: (kind, fn) => listeners.set(kind, fn), effect: create => { const off = create(); if (typeof off === 'function') disposers.push(off) }, connection: { fetch: { register: route => { routes.set(route.path, route); return () => {} } } },
  } }
  install(rt, { makeStore: options => { store = new WebPushStore({ ...options, send: async (_sub, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 } } }); return store } })
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); assert.ok(home.startsWith(join(tmpdir(), 'ds-bot-push-'))); await rm(home, { recursive: true, force: true }) })
  const api = routes.get('/api/bot/web-push').fetch
  const get = await api(new Request('https://gateway.test/api/bot/web-push', { headers: { host: 'gateway.test' } })); const config = await get.json(); const cookie = get.headers.get('set-cookie').split(';')[0]
  assert.match(get.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/); assert.match(get.headers.get('set-cookie'), /; Secure$/)
  const request = (body, headers = {}) => api(new Request('https://gateway.test/api/bot/web-push', { method: 'POST', headers: { host: 'gateway.test', origin: 'https://gateway.test', 'content-type': 'application/json', cookie, 'x-dsbot-push-csrf': config.csrf, ...headers }, body: JSON.stringify(body) }))
  assert.equal((await request({ action: 'subscribe', subscription: subscription() }, { 'x-dsbot-push-csrf': 'wrong' })).status, 403)
  assert.equal((await request({ action: 'subscribe', subscription: subscription() })).status, 200)
  const trigger = listeners.get('session/event'); let seq = 1
  const event = (type, data) => trigger({ id: 'part' }, { type, data, seq: seq++ })
  event('turn/start', { turn: 1 }); event('assistant/message', { message: { content: [{ type: 'text', text: 'Readable final fixture' }] } }); event('turn/end', { reason: { kind: 'completed' } }); await settle(store); assert.equal(sent.at(-1).kind, 'reply')
  const before = sent.length; event('turn/start', { turn: 2 }); event('assistant/message', { message: { content: [{ type: 'text', text: '[SILENT]' }] } }); event('turn/end', { reason: { kind: 'completed' } }); await settle(store); assert.equal(sent.length, before)
  event('turn/start', { turn: 3 }); event('user/message', { source: { kind: 'bot', role: 'reply' } }); event('assistant/message', { message: { content: [{ type: 'text', text: '[SILENT]' }] } }); event('turn/end', { reason: { kind: 'completed' } }); await settle(store); assert.equal(sent.at(-1).kind, 'report')
  state.exchangeTurns.part = [4]; event('turn/start', { turn: 4 }); event('assistant/message', { message: { content: [{ type: 'text', text: 'Hidden exchange' }] } }); event('turn/end', { reason: { kind: 'completed' } }); await settle(store); assert.equal(sent.at(-1).kind, 'report')
  const beforeDispatch = sent.length; waiting = { b: { bots: ['worker'] } }
  event('turn/start', { turn: 6 }); event('assistant/message', { message: { content: [{ type: 'tool-call', name: 'message_bot' }] } }); event('assistant/message', { message: { content: [{ type: 'text', text: 'A worker is running; result pending.' }] } }); event('turn/end', { reason: { kind: 'completed' } }); await settle(store); assert.equal(sent.length, beforeDispatch)
  waiting = {}
  state.questions.part = { id: 'question-fixture' }; saved(); await settle(store); assert.equal(sent.at(-1).kind, 'answer'); const count = sent.length; saved(); await settle(store); assert.equal(sent.length, count)
  approval('open', { id: 'approval-fixture', sessionId: 'part' }); await settle(store); assert.equal(sent.at(-1).kind, 'approval')
  event('turn/start', { turn: 5 }); event('turn/end', { reason: { kind: 'error' } }); await settle(store); assert.equal(sent.at(-1).kind, 'failure')
  const worker = await routes.get('/api/bot/web-push-worker.js').fetch(new Request('https://gateway.test/')); assert.equal(worker.headers.get('service-worker-allowed'), '/'); assert.match(worker.headers.get('cache-control'), /no-store/)
  const other = await api(new Request('https://gateway.test/api/bot/web-push', { headers: { host: 'gateway.test' } })); assert.equal((await other.json()).subscribed, false)
})
