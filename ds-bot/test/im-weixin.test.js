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
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      calls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization, headers: req.headers })
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
      if (req.url === '/ilink/bot/getupdates') {
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
    calls, replies,
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
