import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import weixin from '../src/host/im/platforms/weixin.js'
import manifest from '../package.json' with { type: 'json' }

// A fake iLink: the QR endpoints drive the login states the test wants, the
// getupdates long poll answers from a queued script, and sends are recorded.
async function fakeIlink() {
  const calls = []
  const replies = {}
  let updates = []
  const state = { notified: false }
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      calls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization, headers: req.headers })
      // A raw body, for a proxy error page or any other non-JSON 200.
      if (replies.raw?.[req.url] !== undefined) {
        res.writeHead(200, { 'content-type': 'text/html' }); res.end(replies.raw[req.url])
        return
      }
      if (req.url.startsWith('/ilink/bot/get_bot_qrcode')) {
        const answer = replies.qrcode ?? { qrcode: 'qr-tok-1', qrcode_img_content: 'weixin://qr/abc' }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer))
        return
      }
      if (req.url.startsWith('/ilink/bot/get_qrcode_status')) {
        const status = (replies.statuses ?? ['wait']).shift() ?? replies.lastStatus ?? 'wait'
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(typeof status === 'object' ? status : { status }))
        return
      }
      if (req.url === '/ilink/bot/msg/notifystart') {
        const scripted = replies.notifystartQueue?.shift() ?? { ret: 0 }
        const status = scripted.http ?? 200
        if (status === 200) state.notified = true
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(status === 200 ? (scripted.body ?? scripted) : {}))
        return
      }
      if (req.url === '/ilink/bot/getupdates') {
        // The real server refuses updates until the session is opened.
        if (replies.requireStart === true && !state.notified) {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errcode: -14, errmsg: 'session timeout' }))
          return
        }
        const answer = replies.updatesShift ?? updates.shift() ?? replies.updates ?? { ret: 0, msgs: [], get_updates_buf: 'c1' }
        if (typeof answer === 'function') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer(params))); return }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer))
        return
      }
      const answer = Object.hasOwn(replies, req.url) ? replies[req.url] : { ret: 0 }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer))
    })
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${http.address().port}/`,
    calls, replies, state,
    queue: items => { updates = items },
    close: () => { http.closeAllConnections?.(); http.close() },
  }
}

const env = (fake, runtime = {}) => ({
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  config: { api: fake.base, qr: fake.base },
  runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
  log: { warn: (...args) => console.error('[im-weixin]', ...args) },
})
// The same env, with the statuses and warnings kept for assertions.
const tracked = (fake, runtime = {}) => {
  const statuses = []
  const warns = []
  const watched = { ...env(fake, runtime), log: { warn: (...args) => warns.push(args.join(' ')) } }
  return { env: watched, statuses, warns }
}
const FIELDS = { token: 'wx-tok', baseUrl: '' }

const until = async (fn, tries = 80) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 50))
  }
  return undefined
}

test('login start returns a code, wait reports waiting then scanned then done with the owner', async () => {
  const fake = await fakeIlink()
  fake.replies.statuses = [
    'wait',
    'scaned',
    { status: 'confirmed', bot_token: 'wx-tok', baseurl: fake.base, ilink_bot_id: 'bot-9', ilink_user_id: 'owner-1' },
  ]
  const { loginId, qr, expiresAt } = await weixin.loginStart(env(fake))
  assert.equal(qr, 'weixin://qr/abc')
  assert.ok(expiresAt > Date.now())
  assert.equal((await weixin.loginWait(loginId, env(fake))).status, 'waiting')
  assert.equal((await weixin.loginWait(loginId, env(fake))).status, 'scanned')
  const done = await weixin.loginWait(loginId, env(fake))
  assert.equal(done.status, 'done')
  assert.deepEqual(done.owner, { id: 'owner-1', name: 'owner-1' })
  assert.equal(done.connection.secrets.token, 'wx-tok')
  assert.equal(done.connection.account.id, 'bot-9')
  assert.equal(done.connection.settings.baseUrl, fake.base)
  await fake.close()
})

test('getupdates keeps the cursor and context_token in runtime and delivers text and voice', async (t) => {
  const fake = await fakeIlink()
  const runtime = {}
  const messages = []
  fake.replies.updates = (params) => {
    if (params.get_updates_buf === 'c1') return { ret: 0, msgs: [], get_updates_buf: 'c1' }
    return {
      ret: 0, get_updates_buf: 'c1',
      msgs: [
        { from_user_id: 'u1', client_id: 'm1', context_token: 'tok-u1', item_list: [{ type: 1, text_item: { text: 'hello' } }] },
        { from_user_id: 'u1', client_id: 'm2', context_token: 'tok-u1', item_list: [{ type: 3, voice_item: { text: 'a voice transcript' } }] },
      ],
    }
  }
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => messages.length === 2)
  assert.equal(runtime.cursor, 'c1')
  assert.deepEqual(runtime.contextTokens, { u1: 'tok-u1' })
  assert.equal(messages[0].chat.kind, 'direct')
  assert.equal(messages[0].text, 'hello')
  assert.equal(messages[1].text, 'a voice transcript')
})

test('send goes through sendmessage with the stored context_token, chunked at the limit', async (t) => {
  const fake = await fakeIlink()
  const runtime = { cursor: 'c1', contextTokens: { u1: 'tok-u1' } }
  fake.replies.updates = { ret: 0, msgs: [], get_updates_buf: 'c1' }
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.calls.some(call => call.path === '/ilink/bot/getupdates'))
  const { messageId } = await handle.send({ key: 'u1', kind: 'direct' }, { text: 'x'.repeat(4000) })
  const sends = fake.calls.filter(call => call.path === '/ilink/bot/sendmessage')
  assert.ok(sends.length >= 2, 'chunked at the limit')
  assert.equal(sends[0].params.msg.to_user_id, 'u1')
  assert.equal(sends[0].params.msg.context_token, 'tok-u1')
  assert.equal(sends[0].params.msg.item_list[0].type, 1)
  assert.ok(messageId.startsWith('ds-bot-'))
})

test('a refused send is permanent, and the auth header carries the token', async (t) => {
  const fake = await fakeIlink()
  const runtime = { cursor: 'c1' }
  fake.replies.updates = { ret: 0, msgs: [] }
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.calls.some(call => call.path === '/ilink/bot/getupdates'))
  fake.replies['/ilink/bot/sendmessage'] = { ret: -2, errmsg: 'msg out of window' }
  await assert.rejects(() => handle.send({ key: 'u1', kind: 'direct' }, { text: 'late' }),
    error => error.permanent === true && error.code === -2 && !/window/.test(error.message))
  assert.equal(fake.calls[0].auth, 'Bearer wx-tok')
})


for (const suffix of ['', '/', '///']) {
  test(`iLink normalizes API and QR bases with ${JSON.stringify(suffix)} trailing slashes`, async (t) => {
    const fake = await fakeIlink()
    t.after(() => fake.close())
    const address = fake.base.replace(/\/+$/, '') + suffix
    const environment = env(fake)
    environment.config = { api: address, qr: address }
    fake.replies.statuses = [{ status: 'confirmed', bot_token: 'wx-tok', baseurl: address, ilink_bot_id: 'fixture' }]
    const { loginId } = await weixin.loginStart(environment)
    const login = await weixin.loginWait(loginId, environment)
    assert.equal(login.status, 'done')
    const fields = { ...login.connection.settings, ...login.connection.secrets }
    // A QR response's baseUrl wins over the configured fallback.
    environment.config.api = 'http://127.0.0.1:1/'
    await weixin.check(fields, environment)
    environment.config.api = address
    await weixin.check(FIELDS, environment)
    // The QR API also falls back to config.api when no QR override is set.
    delete environment.config.qr
    fake.replies.statuses = ['expired']
    const fallback = await weixin.loginStart(environment)
    assert.equal((await weixin.loginWait(fallback.loginId, environment)).status, 'expired')
    fake.replies['/ilink/bot/getconfig'] = { ret: 0, typing_ticket: 'synthetic-ticket' }
    const statuses = []
    const handle = weixin.connect(fields, environment, { onMessage: () => {}, onAction: () => {}, onStatus: value => statuses.push(value.state) })
    t.after(() => handle.stop())
    assert.ok(await until(() => statuses.includes('ready')), 'poll reaches ready')
    await handle.send({ key: 'synthetic-user' }, { text: 'synthetic local test' })
    await handle.typing({ key: 'synthetic-user' })
    handle.stop()
    for (const endpoint of ['get_bot_qrcode', 'get_qrcode_status', 'getupdates', 'sendmessage', 'getconfig', 'sendtyping']) {
      assert.ok(fake.calls.some(call => call.path.split('?')[0] === `/ilink/bot/${endpoint}`), endpoint)
    }
    assert.ok(fake.calls.every(call => call.path.startsWith('/ilink/bot/')))
  })
}


test('getupdates accepts a valid envelope without status codes and preserves explicit success', async () => {
  for (const answer of [
    { msgs: [], sync_buf: '', get_updates_buf: 'next' },
    { ret: 0, msgs: [] },
    { errcode: 0, msgs: [], get_updates_buf: 'next' },
    { ret: '0', errcode: '0', errmsg: '', msgs: [], get_updates_buf: '' },
  ]) {
    const environment = { config: {}, fetch: async () => new Response(JSON.stringify(answer), { status: 200 }) }
    assert.equal((await weixin.check(FIELDS, environment)).account.name, 'WeChat')
  }
})

test('getupdates never treats explicit errors or malformed HTTP 200 bodies as success', async () => {
  const valid = { msgs: [], get_updates_buf: 'next' }
  for (const answer of [
    { ...valid, ret: 500 }, { ...valid, errcode: -1 }, { ...valid, ret: 0, errcode: 500 },
    { ...valid, ret: 500, errcode: 0 }, { ...valid, errmsg: 'denied' },
    {}, null, [], 'not an envelope', { msgs: [] }, { get_updates_buf: 'next' },
    { msgs: {}, get_updates_buf: 'next' }, { msgs: [null], get_updates_buf: 'next' },
    { msgs: [], get_updates_buf: 1 }, { ...valid, ret: null }, { ...valid, ret: '' },
    { ...valid, ret: false }, { ...valid, ret: 'bad' }, { ...valid, errmsg: {} },
  ]) {
    const environment = { config: {}, fetch: async () => new Response(JSON.stringify(answer), { status: 200 }) }
    await assert.rejects(weixin.check(FIELDS, environment), /WeChat/)
  }
  await assert.rejects(weixin.check(FIELDS, { config: {}, fetch: async () => new Response('not JSON') }), /invalid updates/)
  for (const code of [401, 403]) {
    await assert.rejects(weixin.check(FIELDS, { config: {}, fetch: async () => new Response(JSON.stringify({ ...valid, errcode: code })) }), error => error.permanent === true)
  }
  await assert.rejects(weixin.check(FIELDS, { config: {}, fetch: async () => new Response(JSON.stringify({ ...valid, errcode: 429 }), { headers: { 'retry-after': '5' } }) }), error => error.retryAfter === 5)
})

test('ret-less live polling reaches ready, advances cursor and delivers messages', async (t) => {
  const fake = await fakeIlink()
  const runtime = {}
  const statuses = []
  const messages = []
  fake.replies.updates = params => ({
    msgs: params.get_updates_buf ? [] : [{ from_user_id: 'fixture-user', client_id: 'fixture-message', item_list: [{ type: 1, text_item: { text: 'fixture text' } }] }],
    sync_buf: '', get_updates_buf: 'next-cursor',
  })
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage: msg => messages.push(msg), onStatus: state => statuses.push(state.state) })
  t.after(() => { handle.stop(); fake.close() })
  assert.ok(await until(() => messages.length === 1))
  assert.ok(statuses.includes('ready'))
  assert.equal(runtime.cursor, 'next-cursor')
  assert.equal(messages[0].text, 'fixture text')
})

test('polling rejects explicit errcode authentication errors instead of announcing ready', async (t) => {
  const fake = await fakeIlink()
  const statuses = []
  fake.replies.updates = { errcode: 401, msgs: [], get_updates_buf: '' }
  const handle = weixin.connect(FIELDS, env(fake), { onMessage: () => assert.fail('error must not deliver messages'), onStatus: state => statuses.push(state.state) })
  t.after(() => { handle.stop(); fake.close() })
  assert.ok(await until(() => statuses.includes('error')))
  assert.ok(!statuses.includes('ready'))
})


test('send rejects errcode and malformed responses without exposing platform context', async (t) => {
  const fake = await fakeIlink()
  const runtime = { contextTokens: { u1: 'synthetic-context' } }
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  for (const answer of [{ errcode: -2, errmsg: 'PRIVATE_CONTEXT_MARKER' }, { ret: 0, errcode: -2 }, { ret: '', errmsg: '' }, { errmsg: 'PRIVATE_CONTEXT_MARKER' }, {}, null, []]) {
    fake.replies['/ilink/bot/sendmessage'] = answer
    await assert.rejects(handle.send({ key: 'u1' }, { text: 'fixture' }), error => error.permanent && error.contextTokenPresent && !error.message.includes('PRIVATE_CONTEXT_MARKER'))
  }
})

test('each send uses the latest inbound context without inventing an expiry duration', async (t) => {
  const fake = await fakeIlink()
  const runtime = { contextTokens: { u1: 'old-context' } }
  let received = false
  fake.replies.updates = params => ({ ret: 0, msgs: params.get_updates_buf ? [] : [{ from_user_id: 'u1', context_token: 'new-context', item_list: [{ type: 1, text_item: { text: 'fixture' } }] }], get_updates_buf: 'next' })
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage() { received = true }, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  assert.ok(await until(() => received))
  await handle.send({ key: 'u1' }, { text: 'fixture' })
  assert.equal(fake.calls.find(call => call.path === '/ilink/bot/sendmessage').params.msg.context_token, 'new-context')
})


test('iLink compatibility metadata uses protocol version plus real host version and official public headers', async (t) => {
  const fake = await fakeIlink()
  t.after(() => fake.close())
  await weixin.loginStart(env(fake))
  await weixin.check(FIELDS, env(fake))
  await weixin.check(FIELDS, env(fake))
  const qr = fake.calls.find(call => call.path.includes('get_bot_qrcode'))
  assert.equal(qr.headers['ilink-app-id'], 'bot')
  assert.equal(qr.headers['ilink-app-clientversion'], '196609')
  const authenticated = fake.calls.filter(call => call.path === '/ilink/bot/getupdates')
  const uins = []
  for (const call of authenticated) {
    assert.equal(call.params.base_info.channel_version, `3.0.1/ds-bot-${manifest.version}`)
    assert.equal(call.params.base_info.bot_agent, 'DSBot')
    assert.equal(call.headers['ilink-app-id'], 'bot')
    assert.equal(call.headers['ilink-app-clientversion'], String((3 << 16) | (0 << 8) | 1))
    assert.equal(call.headers.authorizationtype, 'ilink_bot_token')
    assert.equal(call.auth, 'Bearer wx-tok')
    const encoded = call.headers['x-wechat-uin']
    const decimal = Buffer.from(encoded, 'base64').toString('utf8')
    assert.match(decimal, /^\d+$/)
    assert.ok(Number(decimal) >= 0 && Number(decimal) <= 0xffffffff)
    assert.equal(Buffer.from(decimal).toString('base64'), encoded)
    uins.push(encoded)
  }
  assert.notEqual(uins[0], uins[1], 'each request creates a fresh random UIN')
})

test('send success requires explicit zero or a valid official message_id acknowledgement', async (t) => {
  const fake = await fakeIlink()
  const handle = weixin.connect(FIELDS, env(fake), { onMessage() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  for (const answer of [{ ret: 0, errmsg: '' }, { errcode: 0 }, { ret: '0', errcode: 0, errmsg: '' }, { message_id: '1234567890' }, { message_id: '18446744073709551615' }, { message_id: 12345 }]) {
    fake.replies['/ilink/bot/sendmessage'] = answer
    assert.ok((await handle.send({ key: 'fixture-user' }, { text: 'local only' })).messageId)
  }
  for (const answer of [{}, { errmsg: '' }, { ret: 0, errcode: -2 }, { errcode: 0, ret: -2 }, { message_id: '' }, { message_id: '0' }, { message_id: 'not-an-id' }, { message_id: '18446744073709551616' }, { message_id: '123', ret: -2 }, { message_id: '123', errcode: -2 }, { message_id: '123', errmsg: 'denied' }]) {
    fake.replies['/ilink/bot/sendmessage'] = answer
    await assert.rejects(handle.send({ key: 'fixture-user' }, { text: 'local only' }), error => error.permanent === true)
  }
})


test('failed send diagnostics expose only allowlisted schema, lengths and HTTP status', async (t) => {
  const fake = await fakeIlink()
  const logs = []
  const environment = env(fake)
  environment.log = { warn: (...args) => logs.push(args) }
  const handle = weixin.connect(FIELDS, environment, { onMessage() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  fake.replies['/ilink/bot/sendmessage'] = { message_id: 'SENSITIVE_ACK_ID', errmsg: '', PRIVATE_DYNAMIC_KEY: 'PRIVATE_BODY_VALUE' }
  await assert.rejects(handle.send({ key: 'PRIVATE_RECIPIENT' }, { text: 'PRIVATE_MESSAGE' }), /invalid send/)
  const row = logs.find(args => args[0].includes('send validation failed'))
  assert.ok(row)
  const schema = JSON.parse(row[1])
  assert.equal(schema.httpStatus, 200)
  assert.ok(schema.responseBytes > 0)
  assert.deepEqual(schema.fields, ['errmsg', 'message_id'])
  assert.equal(schema.retPresent, false)
  assert.equal(schema.errcodePresent, false)
  assert.equal(schema.errmsgLength, 0)
  assert.equal(schema.messageIdLength, 16)
  assert.equal(schema.unknownFieldCount, 1)
  const diagnostic = JSON.stringify(row)
  for (const value of ['SENSITIVE_ACK_ID', 'PRIVATE_DYNAMIC_KEY', 'PRIVATE_BODY_VALUE', 'PRIVATE_RECIPIENT', 'PRIVATE_MESSAGE']) assert.ok(!diagnostic.includes(value))
  fake.replies['/ilink/bot/sendmessage'] = {}
  await assert.rejects(handle.send({ key: 'PRIVATE_RECIPIENT' }, { text: 'PRIVATE_MESSAGE' }), /invalid send/)
  assert.deepEqual(JSON.parse(logs.at(-1)[1]).fields, [])
})


test('numeric uint64 message acknowledgements are parsed without precision loss', async (t) => {
  const fake = await fakeIlink()
  const environment = env(fake)
  const baseFetch = environment.fetch
  environment.fetch = async (url, options) => String(url).endsWith('/sendmessage')
    ? new Response('{"message_id":18446744073709551615}', { status: 200 })
    : baseFetch(url, options)
  const handle = weixin.connect(FIELDS, environment, { onMessage() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  assert.ok((await handle.send({ key: 'fixture-user' }, { text: 'local only' })).messageId)
})

// The client identity iLink expects: app id "bot", client version 2.4.6 packed
// as 0x00MMNNPP, and X-WECHAT-UIN = base64 of a decimal uint32.
const CLIENT_VERSION = (3 << 16) | 1
const assertClientHeaders = (call) => {
  assert.equal(call.headers['ilink-app-id'], 'bot')
  assert.equal(call.headers['ilink-app-clientversion'], String(CLIENT_VERSION))
  assert.equal(call.headers.authorizationtype, 'ilink_bot_token')
  assert.equal(call.auth, 'Bearer wx-tok')
  const uin = Buffer.from(call.headers['x-wechat-uin'], 'base64').toString('utf8')
  assert.match(uin, /^\d+$/)
}

test('connect opens the session with msg/notifystart before polling', async (t) => {
  const fake = await fakeIlink()
  fake.replies.requireStart = true
  const { env: watched, statuses } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'ready'))
  assert.ok(statuses.some(status => status.state === 'ready'), 'the session reached ready')
  const paths = fake.calls.map(call => call.path).filter(path => path.endsWith('notifystart') || path === '/ilink/bot/getupdates')
  assert.deepEqual(paths.slice(0, 2), ['/ilink/bot/msg/notifystart', '/ilink/bot/getupdates'])
  const start = fake.calls.find(call => call.path === '/ilink/bot/msg/notifystart')
  const poll = fake.calls.find(call => call.path === '/ilink/bot/getupdates')
  assertClientHeaders(start)
  assertClientHeaders(poll)
})

test('the QR login requests carry the same client identity', async () => {
  const fake = await fakeIlink()
  fake.replies.statuses = ['confirmed']
  const { loginId } = await weixin.loginStart(env(fake))
  await weixin.loginWait(loginId, env(fake))
  for (const path of ['/ilink/bot/get_bot_qrcode', '/ilink/bot/get_qrcode_status']) {
    const call = fake.calls.find(entry => entry.path.startsWith(path))
    assert.equal(call.headers['ilink-app-id'], 'bot')
    assert.equal(call.headers['ilink-app-clientversion'], String(CLIENT_VERSION))
  }
  await fake.close()
})

test('a transient session start failure is retried before polling', async (t) => {
  const fake = await fakeIlink()
  fake.replies.notifystartQueue = [{ http: 503 }, { http: 503 }, { ret: 0 }]
  const { env: watched, statuses } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'ready'), 160)
  assert.ok(statuses.some(status => status.state === 'ready'), 'the session started on a later attempt')
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/msg/notifystart').length, 3)
  assert.ok(fake.calls.some(call => call.path === '/ilink/bot/getupdates'), 'polling starts after the retries')
})

test('a session start that keeps failing is shown once and still retried until it works', async (t) => {
  const fake = await fakeIlink()
  fake.replies.notifystartQueue = [{ http: 500 }, { http: 500 }, { http: 500 }, { http: 500 }, { http: 500 }, { ret: 0 }]
  const { env: watched, statuses, warns } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error'), 200)
  const failed = statuses.find(status => status.state === 'error')
  assert.ok(failed, 'the connection reports the failure')
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/getupdates').length, 0, 'no poll before the session starts')
  await until(() => statuses.some(status => status.state === 'ready'), 400)
  assert.ok(statuses.some(status => status.state === 'ready'), 'the session started once the network came back')
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/msg/notifystart').length, 6)
  assert.ok(fake.calls.some(call => call.path === '/ilink/bot/getupdates'), 'polling starts after the session')
  assert.equal(statuses.filter(status => status.state === 'error').length, 1, 'the failure is shown once')
  assert.equal(warns.filter(line => /could not start the session/.test(line)).length, 1)
})

test('-14 on the session start is permanent, shown once, and polling never starts', async (t) => {
  const fake = await fakeIlink()
  fake.replies.notifystartQueue = [{ errcode: -14, errmsg: 'session timeout' }]
  const { env: watched, statuses } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error'))
  const failed = statuses.find(status => status.state === 'error')
  assert.match(String(failed?.error), /session expired/i)
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/msg/notifystart').length, 1)
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/getupdates').length, 0)
})

test('-14 in getupdates is shown as a session error and stops the poll', async (t) => {
  const fake = await fakeIlink()
  fake.replies.updates = { errcode: -14, errmsg: 'session timeout' }
  const { env: watched, statuses, warns } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error'))
  const failed = statuses.find(status => status.state === 'error')
  assert.match(String(failed?.error), /session expired/i)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(fake.calls.filter(call => call.path === '/ilink/bot/getupdates').length, 1)
  assert.equal(warns.filter(line => /session expired/.test(line)).length, 1)
})

test('an answer without ret or errcode is not taken as a session error', async (t) => {
  const fake = await fakeIlink()
  fake.replies.updates = { msgs: [], get_updates_buf: 'c1' }
  const { env: watched, statuses, warns } = tracked(fake)
  const handle = weixin.connect(FIELDS, watched, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  // iLink omits the error code on success; a missing code must never be read
  // as an expired session.
  await until(() => fake.calls.filter(call => call.path === '/ilink/bot/getupdates').length >= 2, 200)
  assert.equal(statuses.some(status => status.state === 'error'), false)
  assert.equal(warns.some(line => /session expired/.test(line)), false)
})

// iLink answers with the bare host and the request URL appends its path, so the
// connection base and the QR base must end in exactly one slash for every form the
// user, the scan or a copied URL can produce.
test('the QR base and the connection base end in exactly one slash', async (t) => {
  const fake = await fakeIlink()
  t.after(() => fake.close())
  const origin = fake.base.replace(/\/$/, '')
  for (const suffix of ['', '/', '///']) {
    const qrEnv = { ...env(fake), config: { qr: `${origin}${suffix}` } }
    await weixin.loginStart(qrEnv)
    const start = fake.calls.at(-1)
    assert.equal(start.path, '/ilink/bot/get_bot_qrcode?bot_type=3', `QR base ${JSON.stringify(suffix)}`)
    for (const api of [origin, `${origin}/`, `${origin}///`]) {
      const fields = { token: 'wx-tok', baseUrl: '' }
      const answer = await weixin.check({ ...fields, baseUrl: api }, { ...env(fake), config: { api } })
      assert.deepEqual(answer.account, { id: '', name: 'WeChat' })
      assert.equal(fake.calls.at(-1).path, '/ilink/bot/getupdates', `baseUrl ${JSON.stringify(api)}`)
    }
  }
})

test('check passes when the answer carries no ret, and a non-zero ret is still an error', async () => {
  const fake = await fakeIlink()
  try {
    fake.replies.updates = { msgs: [], sync_buf: 's1', get_updates_buf: 'c1' }
    const answer = await weixin.check({ token: 'wx-tok', baseUrl: '' }, env(fake))
    assert.equal(answer.account.name, 'WeChat')
    fake.replies.updates = { ret: -2, errmsg: 'bad token' }
    await assert.rejects(
      () => weixin.check({ token: 'wx-tok', baseUrl: '' }, env(fake)),
      error => error.permanent === true && /answered -2/.test(error.message))
  } finally {
    await fake.close()
  }
})

test('an idle getupdates without ret is a success: ready, cursor and message', async (t) => {
  const fake = await fakeIlink()
  const runtime = {}
  const messages = []
  const statuses = []
  let polls = 0
  // The real idle answer has no ret at all; only errors carry one.
  fake.replies.updates = () => {
    polls += 1
    if (polls === 1) {
      return {
        msgs: [{ from_user_id: 'u1', client_id: 'm1', context_token: 'tok-u1', item_list: [{ type: 1, text_item: { text: 'hello without ret' } }] }],
        get_updates_buf: 'c2',
      }
    }
    return { msgs: [], get_updates_buf: 'c2' }
  }
  const handle = weixin.connect(FIELDS, env(fake, runtime), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: status => { statuses.push(status) } })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => messages.length === 1)
  assert.equal(messages[0].text, 'hello without ret')
  assert.equal(runtime.cursor, 'c2')
  assert.equal(runtime.contextTokens.u1, 'tok-u1')
  assert.ok(statuses.some(status => status.state === 'ready'), JSON.stringify(statuses))
})

test('a non-zero ret during the poll is still an error and 401 stops it', async (t) => {
  const fake = await fakeIlink()
  const statuses = []
  fake.replies.updates = { ret: 401 }
  const handle = weixin.connect(FIELDS, env(fake, {}), { onMessage: () => {}, onAction: () => {}, onStatus: status => { statuses.push(status) } })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => statuses.some(status => status.state === 'error'))
  assert.match(statuses.find(status => status.state === 'error').error, /401/)
})

test('a network failure keeps its cause for diagnosis', async () => {
  const fake = await fakeIlink()
  try {
    const network = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })
    const failing = { ...env(fake), fetch: async () => { throw network } }
    await assert.rejects(() => weixin.check({ token: 'wx-tok', baseUrl: '' }, failing), (error) => {
      assert.match(error.message, /ENOTFOUND/)
      assert.equal(error.cause, network)
      assert.equal(error.timeout, false)
      return true
    })
  } finally {
    await fake.close()
  }
})

// A missing ret only means success when the body is a real getupdates answer: a
// proxy error page (non-JSON) or an empty object must not read as an idle poll.
test('check refuses a non-JSON answer and an empty object without ret', async () => {
  const fake = await fakeIlink()
  try {
    fake.replies.raw = { '/ilink/bot/getupdates': '<html>bad gateway</html>' }
    await assert.rejects(
      () => weixin.check({ token: 'wx-tok', baseUrl: '' }, env(fake)),
      error => error.permanent !== true && /unreadable/.test(error.message))
    delete fake.replies.raw
    fake.replies.updates = {}
    await assert.rejects(
      () => weixin.check({ token: 'wx-tok', baseUrl: '' }, env(fake)),
      error => error.permanent !== true && /unreadable/.test(error.message))
  } finally {
    await fake.close()
  }
})

test('the poll never reports ready for a non-JSON or empty answer without ret', async () => {
  for (const answer of ['not json at all', {}]) {
    const fake = await fakeIlink()
    const statuses = []
    if (typeof answer === 'string') fake.replies.raw = { '/ilink/bot/getupdates': answer }
    else fake.replies.updates = answer
    const handle = weixin.connect(FIELDS, env(fake, {}), { onMessage: () => {}, onAction: () => {}, onStatus: status => { statuses.push(status) } })
    try {
      await until(() => statuses.filter(status => status.state === 'connecting').length >= 2)
      await new Promise(done => setTimeout(done, 150))
      assert.ok(statuses.length >= 2, JSON.stringify(statuses))
      assert.ok(!statuses.some(status => status.state === 'ready'), `ready after ${JSON.stringify(answer)}: ${JSON.stringify(statuses)}`)
      assert.ok(statuses.some(status => status.state === 'connecting'), JSON.stringify(statuses))
    } finally {
      handle.stop()
      await fake.close()
    }
  }
})
