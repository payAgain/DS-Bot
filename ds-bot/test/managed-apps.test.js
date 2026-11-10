import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { connectionServiceUrl, createManagedApps } from '../src/host/connectors/managed-apps.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'

async function fixture(t) {
  const token = randomBytes(32).toString('hex')
  const state = { registrations: 0, calls: [], accounts: [], refused: false, toolFailure: false, catalogReads: [],
    catalogPages: [
      { items: [{ slug: 'gmail', name: 'Gmail' }, { slug: '_1password', name: '1Password' }], next_cursor: 'next-page' },
      { items: [{ slug: 'zebra', name: 'Zebra' }], next_cursor: null },
    ] }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (state.refused) return json({ error: 'refused' }, 403)
    if (req.url === '/v1/installations' && req.method === 'POST') {
      state.registrations++
      return json({ installationId: 'fixture-installation', token }, 201)
    }
    if (req.headers.authorization !== `Bearer ${token}`) return json({ error: 'unauthorized' }, 401)
    if (req.url.startsWith('/v1/catalog')) {
      state.catalogReads.push(req.url)
      const cursor = new URL(req.url, 'http://localhost').searchParams.get('cursor')
      const page = cursor ? state.catalogPages.findIndex(item => item.next_cursor === cursor) + 1 : 0
      return json(state.catalogPages[page] ?? { items: [], next_cursor: null })
    }
    if (req.url === '/v1/connectors/connected') {
      const gate = state.nextAccountRead
      state.nextAccountRead = undefined
      if (gate) { gate.started(); await gate.wait }
      return json({ services: {
        gmail: { accounts: state.accounts }, _1password: { accounts: [] },
      } })
    }
    if (req.url === '/v1/connectors/gmail/authorize') {
      state.authorizeLabel = body.alias
      return json({ url: 'https://connect.composio.dev/fixture-authorization' })
    }
    if (req.url === '/v1/connectors/gmail/accounts/ca-fixture' && req.method === 'DELETE') {
      state.accounts = []
      return json({ removed: 1 })
    }
    if (req.url === '/v1/mcp') {
      if (req.method === 'GET') return json({ error: 'unsupported' }, 405)
      if (req.method === 'DELETE') { res.writeHead(202); return res.end() }
      if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
      const result = value => json({ jsonrpc: '2.0', id: body.id, result: value })
      if (body.method === 'initialize') return result({
        protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
      })
      if (body.method === 'tools/list') return result({ tools: [
        'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'COMPOSIO_MULTI_EXECUTE_TOOL',
      ].map(name => ({ name, inputSchema: { type: 'object' } })) })
      if (body.method === 'tools/call') {
        state.calls.push(body.params)
        if (state.toolFailure) return json({ error: 'unknown result' }, 503)
        const value = body.params.name === 'COMPOSIO_SEARCH_TOOLS' ? {
          successful: true,
          data: { session: { id: 'fixture-search' }, tool_schemas: {
            GMAIL_FETCH_EMAILS: { toolkit: 'gmail', tool_slug: 'GMAIL_FETCH_EMAILS', description: 'Read mail', input_schema: { type: 'object' } },
            NOTION_DELETE_PAGE: { toolkit: 'notion', tool_slug: 'NOTION_DELETE_PAGE', input_schema: { type: 'object' } },
          } },
        } : { successful: true, data: { results: [{ successful: true, data: { messages: [] } }] } }
        return result({ content: [{ type: 'text', text: JSON.stringify(value) }] })
      }
      return result({})
    }
    return json({ error: 'not found' }, 404)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return { ...state, state, token, url: `http://127.0.0.1:${server.address().port}` }
}

test('connection service addresses reject credential forwarding and permit fixture loopback', () => {
  assert.equal(connectionServiceUrl('https://service.test/'), 'https://service.test')
  for (const url of ['http://service.test', 'https://user@service.test', 'https://service.test/?key=x']) {
    assert.throws(() => connectionServiceUrl(url))
  }
})

test('managed service registers independently, preserves toolkit slugs and opens new authorization', async t => {
  const fake = await fixture(t)
  const api = createManagedApps({ url: fake.url })
  t.after(() => api.close())
  const installation = await api.register()
  assert.equal(installation.token, fake.token)
  assert.equal(fake.state.registrations, 1)
  const page = await api.catalog()
  assert.deepEqual(page.items.map(item => item.slug), ['gmail', '_1password', 'zebra'])
  assert.equal(page.cursor, null)
  assert.equal(page.pagination.complete, true)
  assert.deepEqual((await api.catalog({ query: 'gmail' })).items.map(item => item.slug), ['gmail'])
  assert.match((await api.authorize('gmail', 'New account')).url, /^https:\/\/connect\.composio\.dev\//)
  assert.equal(fake.state.authorizeLabel, 'New account')
})

test('managed catalog searches every upstream page and paginates cached results locally', async t => {
  const fake = await fixture(t)
  const app = i => ({ slug: `app_${i}`, name: `App ${i}` })
  fake.state.catalogPages = [
    { items: Array.from({ length: 40 }, (_, i) => app(i)), next_cursor: 'page-two', current_page: 1, total_items: 81 },
    { items: Array.from({ length: 41 }, (_, i) => app(i + 40)), next_cursor: null, current_page: 2, total_items: 81 },
  ]
  const api = createManagedApps({ url: fake.url, token: fake.token })
  t.after(() => api.close())
  const found = await api.catalog({ query: 'app_80' })
  assert.deepEqual(found.items.map(item => item.slug), ['app_80'])
  assert.equal(found.pagination.complete, true)
  assert.equal(fake.state.catalogReads.length, 2)
  const first = await api.catalog()
  assert.equal(first.items.length, 40)
  const second = await api.catalog({ cursor: first.cursor })
  const third = await api.catalog({ cursor: second.cursor })
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(item => item.slug)).size, 81)
  assert.equal(third.cursor, null)
  assert.equal(fake.state.catalogReads.length, 2, 'search and local pagination reuse this installation cache')
})

test('managed catalog stops repeated cursors and reports a partial marketplace', async t => {
  const fake = await fixture(t)
  fake.state.catalogPages = [
    { items: [{ slug: 'gmail', name: 'Gmail' }], next_cursor: 'repeated' },
    { items: [{ slug: 'notion', name: 'Notion' }], next_cursor: 'repeated' },
  ]
  const api = createManagedApps({ url: fake.url, token: fake.token })
  t.after(() => api.close())
  const page = await api.catalog()
  assert.equal(fake.state.catalogReads.length, 2)
  assert.equal(page.pagination.complete, false)
  assert.equal(page.pagination.reason, 'cursor-repeated')
  assert.match(page.warning, /incomplete/)
})

test('managed tool discovery stays within the app, refuses account ambiguity and never replays execution', async t => {
  const fake = await fixture(t)
  const api = createManagedApps({ url: fake.url, token: fake.token })
  t.after(() => api.close())
  fake.state.accounts = [{ id: 'ca-fixture', alias: 'Personal', status: 'ACTIVE' }]
  const account = (await api.accounts())[0]
  const tools = await api.search(account, 'Read inbox')
  assert.deepEqual(tools.map(tool => tool.slug), ['GMAIL_FETCH_EMAILS'])
  const tool = tools[0]
  assert.throws(() => api.tool(tool.slug, tool.version, 'another-account'), /Search this/)
  fake.state.accounts.push({ id: 'ca-second', status: 'ACTIVE' })
  await assert.rejects(api.execute(account, tool.slug, tool.version, {}), /one active account/)
  assert.equal(fake.state.calls.length, 1)
  fake.state.accounts.pop()
  await assert.rejects(api.execute(account, tool.slug, tool.version, {}, undefined, () => { throw new Error('permission revoked') }), /permission revoked/)
  assert.equal(fake.state.calls.length, 1)
  await api.execute(account, tool.slug, tool.version, {})
  assert.equal(fake.state.calls.length, 2)
  assert.deepEqual(fake.state.calls[1].arguments.tools, [{ tool_slug: tool.slug, arguments: {} }])
  fake.state.toolFailure = true
  await assert.rejects(api.execute(account, tool.slug, tool.version, {}))
  assert.equal(fake.state.calls.length, 3, 'a failed tool call is sent once')
})

test('DS Bot expands its existing connectors without a project key and executes automatically for authorized Bots', async t => {
  const fake = await fixture(t)
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-managed-apps-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'], bots: { a: { id: 'a', sessionId: 'a', name: 'Chief', createdAt: 1 } }, rooms: {},
  }))
  const approval = fakeApproval()
  const ctx = fakeContext({ services: { approval } })
  const rt = createRuntime(ctx, { home, connectedAppsService: fake.url })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  assert.equal((await rt.composioEndpoint('composio-status')).mode, 'managed')
  assert.ok(rt.connectorsView().connectors.some(item => item.id === 'github'))
  await Promise.all([rt.composioEndpoint('composio-catalog'), rt.composioEndpoint('composio-catalog')])
  assert.equal(fake.state.registrations, 1)
  const initial = await rt.composioEndpoint('composio-status')
  assert.equal(initial.configured, true)
  assert.ok(!JSON.stringify(initial).includes(fake.token))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(fake.token))
  const authorization = await rt.composioEndpoint('composio-connect', { toolkit: 'gmail' })
  assert.equal(authorization.pending.length, 1)
  fake.state.accounts = [{ id: 'ca-fixture', alias: fake.state.authorizeLabel, status: 'ACTIVE' }]
  const refreshed = await rt.composioEndpoint('composio-refresh')
  assert.equal(refreshed.pending.length, 0)
  assert.ok(rt.extendedConnectorRows().some(row => row.id === 'app:gmail'))
  const listed = await rt.teamTools.find(tool => tool.name === 'list_connectors').execute({}, { agent: { id: 'a' } })
  assert.match(listed, /GitHub/)
  assert.match(listed, /app:gmail/)
  const search = rt.teamTools.find(tool => tool.name === 'search_app_tools')
  const execute = rt.teamTools.find(tool => tool.name === 'execute_app_tool')
  const exec = { agent: { id: 'a', ctx }, signal: AbortSignal.timeout(10_000), name: 'execute_app_tool' }
  await assert.rejects(search.execute({ accountId: 'ca-fixture', query: 'read mail' }, exec), /not enabled/)
  const access = await rt.composioEndpoint('composio-policy', { id: 'ca-fixture', mode: 'ask', bots: ['a'], enabled: true })
  assert.equal(access.accounts[0].mode, 'auto', 'legacy clients cannot reintroduce per-action approval')
  const found = JSON.parse(await search.execute({ accountId: 'ca-fixture', query: 'read mail' }, exec))
  await execute.execute({ accountId: 'ca-fixture', tool: found[0].tool, version: found[0].version, arguments: {} }, exec)
  assert.equal(approval.requests.length, 0, 'connected apps run automatically after Bot authorization')
  const readonly = rt.readOnly
  rt.readOnly = () => 'Another window owns this team'
  await assert.rejects(rt.composioEndpoint('composio-connect', { toolkit: 'gmail' }), /read-only/)
  rt.readOnly = readonly
  await rt.composioEndpoint('composio-disconnect', { id: 'ca-fixture', confirm: true })
  assert.equal(fake.state.accounts.length, 0)
  assert.ok(rt.connectorsView().connectors.some(item => item.id === 'github'))
})

async function connectedRuntime(t, services = {}) {
  const fake = await fixture(t)
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-auto-apps-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'], bots: {
      a: { id: 'a', sessionId: 'a', name: 'Chief', createdAt: 1 },
      b: { id: 'b', sessionId: 'b', name: 'Other Bot', createdAt: 2 },
    }, rooms: {},
  }))
  const ctx = fakeContext({ services })
  const contexts = [ctx]
  const rt = createRuntime(ctx, { home, connectedAppsService: fake.url })
  t.after(async () => { for (const context of [...contexts].reverse()) await context.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.composioEndpoint('composio-catalog')
  fake.state.accounts = [{ id: 'ca-fixture', alias: 'Fixture Gmail', status: 'ACTIVE' }]
  await rt.composioEndpoint('composio-refresh')
  const grant = (mode, extra = {}) => rt.composioEndpoint('composio-policy', { id: 'ca-fixture', mode, bots: ['a'], enabled: true, ...extra })
  const search = rt.teamTools.find(tool => tool.name === 'search_app_tools')
  const execute = rt.teamTools.find(tool => tool.name === 'execute_app_tool')
  const exec = { agent: { id: 'a', ctx }, signal: AbortSignal.timeout(10000), name: 'execute_app_tool' }
  const find = async () => JSON.parse(await search.execute({ accountId: 'ca-fixture', query: 'read mail' }, exec))[0]
  const run = (tool, caller = exec) => execute.execute({ accountId: 'ca-fixture', tool: tool.tool, version: tool.version, arguments: {} }, caller)
  return { rt, ctx, contexts, home, fake, grant, find, run, exec }
}

test('app access defaults to automatic without an approval service and preserves native connectors', async t => {
  const f = await connectedRuntime(t)
  await f.grant(undefined)
  const tool = await f.find()
  await f.run(tool)
  const calls = f.fake.state.calls.filter(call => call.name === 'COMPOSIO_MULTI_EXECUTE_TOOL')
  assert.equal(calls.length, 1)
  assert.equal(f.rt.extendedConnectorUsable('a', 'gmail'), true)
  assert.ok(f.rt.connectorsView().connectors.some(row => row.id === 'github'))
  const list = f.rt.teamTools.find(tool => tool.name === 'connected_apps')
  assert.equal(JSON.parse(await list.execute({}, f.exec))[0].permission, 'auto')
  await f.ctx.dispose()
  const restoredContext = fakeContext()
  f.contexts.push(restoredContext)
  const restored = createRuntime(restoredContext, { home: f.home, connectedAppsService: f.fake.url })
  await restored.load()
  const state = await restored.composioEndpoint('composio-refresh')
  assert.equal(state.accounts[0].mode, 'auto')
  assert.deepEqual(state.accounts[0].bots, ['a'])
  assert.equal(f.fake.state.registrations, 1)
})

test('automatic defaults respect Bot and account grants while legacy read and ask choices no longer block', async t => {
  const approval = fakeApproval('rejected')
  const f = await connectedRuntime(t, { approval })
  await f.grant('auto')
  const tool = await f.find()
  await assert.rejects(f.run(tool, { ...f.exec, agent: { id: 'b', ctx: f.ctx } }), /not enabled/)
  await f.grant('auto', { enabled: false })
  await assert.rejects(f.run(tool), /not enabled/)
  await f.grant('read')
  await f.run(tool)
  await f.grant('ask')
  await f.run(tool)
  assert.equal(approval.requests.length, 0)
  assert.equal(f.fake.state.calls.filter(call => call.name === 'COMPOSIO_MULTI_EXECUTE_TOOL').length, 2)
  await assert.rejects(f.grant(undefined, { bots: ['unknown'] }), /Choose valid Bots/)
  await f.grant(undefined)
  await f.run(tool)
  assert.equal(approval.requests.length, 0)
})

test('disabling an account while it is being checked prevents the pending remote action', async t => {
  const f = await connectedRuntime(t)
  await f.grant('auto')
  const tool = await f.find()
  let reached, release
  const started = new Promise(resolve => { reached = resolve })
  const wait = new Promise(resolve => { release = resolve })
  f.fake.state.nextAccountRead = { started: reached, wait }
  const execution = f.run(tool)
  const rejected = assert.rejects(execution)
  try {
    await started
    await f.grant(undefined, { enabled: false })
  } finally { release() }
  await rejected
  assert.equal(f.fake.state.calls.filter(call => call.name === 'COMPOSIO_MULTI_EXECUTE_TOOL').length, 0)
})

test('saved read-only and approval policies are treated as automatic after loading, without broadening Bot access', async t => {
  const approval = fakeApproval('rejected')
  const f = await connectedRuntime(t, { approval })
  for (const [revision, mode] of ['read', 'ask'].entries()) {
    f.rt.state.composio.policies['ca-fixture'] = { mode, enabled: true, bots: ['a'], revision }
    await f.rt.save()
    const status = await f.rt.composioEndpoint('composio-status')
    assert.equal(status.accounts[0].mode, 'auto')
    assert.deepEqual(status.accounts[0].bots, ['a'])
    const tool = await f.find()
    await f.run(tool)
    await assert.rejects(f.run(tool, { ...f.exec, agent: { id: 'b', ctx: f.ctx } }), /not enabled/)
  }
  assert.equal(approval.requests.length, 0)
})

test('a refused official service is reported without hiding or modifying native connectors', async t => {
  const fake = await fixture(t)
  fake.state.refused = true
  const api = createManagedApps({ url: fake.url })
  t.after(() => api.close())
  await assert.rejects(api.register(), /HTTP 403/)
  assert.equal(fake.state.registrations, 0)
})

test('an unavailable service leaves a browsable source catalog without creating accounts or grants', async t => {
  const fake = await fixture(t)
  fake.state.refused = true
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-offline-catalog-'))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, connectedAppsService: fake.url })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  const page = await rt.composioEndpoint('composio-catalog')
  assert.equal(page.source, 'curated')
  assert.equal(page.available, false)
  assert.equal(page.items.length, 24)
  assert.match(page.warning, /HTTP 403/)
  assert.equal((await rt.composioEndpoint('composio-status')).configured, false)
  assert.deepEqual((await rt.composioEndpoint('composio-catalog', { query: 'gmail' })).items.map(item => item.slug), ['gmail'])
  await assert.rejects(rt.composioEndpoint('composio-connect', { toolkit: 'gmail' }), /HTTP 403/)
  assert.equal((await rt.composioEndpoint('composio-status')).accounts.length, 0)
  assert.equal(fake.state.registrations, 0)
  fake.state.refused = false
  await rt.composioEndpoint('composio-retry-service')
  const online = await rt.composioEndpoint('composio-catalog')
  assert.equal(online.source, 'api')
  assert.equal(online.available, true)
  assert.equal(fake.state.registrations, 1)
  fake.state.catalogPages = [{ items: [], next_cursor: null }]
  await rt.composioEndpoint('composio-retry-service')
  const empty = await rt.composioEndpoint('composio-catalog')
  assert.equal(empty.source, 'curated')
  assert.equal(empty.available, false)
  assert.match(empty.warning, /invalid app catalog/)
  assert.equal(fake.state.registrations, 1, 'a catalog outage does not discard the installation identity')
  assert.ok(rt.connectorsView().connectors.some(item => item.id === 'github'))
})
