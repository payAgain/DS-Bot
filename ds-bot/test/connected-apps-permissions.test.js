import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'

test('project-backed accounts execute automatically by default and ignore legacy approval modes', async t => {
  const original = globalThis.fetch
  const sent = [], paths = []
  const account = { id: 'ca-project-fixture', status: 'ACTIVE', toolkit: { slug: 'gmail' }, user_id: 'fixture-user',
    auth_config: { id: 'ac-fixture', auth_scheme: 'OAUTH2', is_composio_managed: true, is_disabled: false },
    word_id: null, alias: 'Fixture Gmail', created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T00:00:00Z',
    state: { authScheme: 'OAUTH2', val: { status: 'ACTIVE' } }, data: {}, status_reason: null, is_disabled: false }
  const tool = { slug: 'GMAIL_SEND_EMAIL', name: 'Send email', description: 'Synthetic send', version: '20261109_00',
    toolkit: { slug: 'gmail', name: 'Gmail' }, tags: [],
    input_parameters: { type: 'object', properties: {} }, output_parameters: { type: 'object' } }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
    if (url.hostname !== 'backend.composio.dev') return original(input, init)
    const path = url.pathname.replace(/^\/api\/v3(?:\.1)?/, '')
    paths.push(path)
    if (path === '/connected_accounts') return Response.json({ items: [account], next_cursor: null, total_items: 1, total_pages: 1, current_page: 1 })
    if (path === '/connected_accounts/ca-project-fixture') return Response.json(account)
    if (path === '/tools/GMAIL_SEND_EMAIL') return Response.json(tool)
    if (path === '/tools/execute/GMAIL_SEND_EMAIL') {
      const body = init.body ?? await input.text()
      sent.push(JSON.parse(body))
      return Response.json({ successful: true, error: null, data: { fixtureSent: true } })
    }
    throw new Error(`Unexpected fixture request: ${path}`)
  }
  t.after(() => { globalThis.fetch = original })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-project-auto-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'], bots: { a: { id: 'a', sessionId: 'a', name: 'Chief', createdAt: 1 } }, rooms: {},
  }))
  const approval = fakeApproval('rejected'), ctx = fakeContext({ services: { approval } })
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await rt.composioEndpoint('composio-configure', { apiKey: 'synthetic-project-fixture', userId: 'fixture-user' })
  await rt.composioEndpoint('composio-refresh')
  const grant = mode => rt.composioEndpoint('composio-policy', { id: account.id, ...(mode ? { mode } : {}), bots: ['a'], enabled: true })
  const execute = rt.teamTools.find(tool => tool.name === 'execute_app_tool')
  const exec = { agent: { id: 'a', ctx }, name: 'execute_app_tool', signal: AbortSignal.timeout(10000) }
  const args = { accountId: account.id, tool: tool.slug, version: tool.version, arguments: { fixture: true } }
  for (const mode of ['read', 'ask', undefined]) {
    const access = await grant(mode)
    assert.equal(access.accounts[0].mode, 'auto')
    await execute.execute(args, exec)
  }
  assert.equal(approval.requests.length, 0)
  assert.equal(sent.length, 3)
  assert.equal(sent[0].connected_account_id, account.id)
  assert.equal(sent[0].version, tool.version)
  assert.deepEqual(sent[0].arguments, args.arguments)
  assert.ok(paths.includes('/connected_accounts/ca-project-fixture'))
})
