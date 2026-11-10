import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as permissions } from '../src/host/permissions.js'
import { install as approvals } from '../src/host/approvals.js'
import { fakeContext } from './fake-ctx.js'

function runtime(permission) {
  const bot = { id: 'b', name: 'Writer', ...(permission ? { permission } : {}) }
  const room = { id: 'r', name: 'Ops', sessions: { b: 'gb' } }
  const modes = new Map(), policies = new Map(), agents = new Map()
  const writes = [], audit = []
  let interactive = 0, policyWrites = 0
  const permissionPresets = {
    catalog: () => ({ options: ['read-only', 'workspace-write', 'danger-full-access'].map(value => ({ value })), defaultPreset: 'workspace-write' }),
    resolve: (name) => {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(name)) throw new Error('unknown preset')
    },
    set(session, name) {
      writes.push([session.id, name])
      modes.set(session.id, name)
      policies.set(session.id, name === 'danger-full-access' ? 'never' : 'ask')
    },
  }
  const approval = {
    overrideOf: session => policies.get(session.id),
    setPolicy(agent, value) { policies.set(agent.session.id, value); policyWrites++ },
    async request(request) {
      const result = policies.get(request.agent.session.id) === 'never' ? 'rejected'
        : await ctx.listeners.get('approval/request')[0](request, () => {
          interactive++
          return new Promise(() => {})
        })
      audit.push({ tool: request.toolName, outcome: result })
      return result
    },
  }
  const ctx = fakeContext({ services: {
    permissionPresets, approval,
    sandboxPolicy: { resolve: ({ session }) => ({ mode: modes.get(session.id) ?? 'workspace-write' }) },
  } })
  const rt = {
    ctx, botOf: id => id === 'b' ? bot : undefined,
    roomOf: id => id === 'r' ? room : undefined,
    chatOwners: new Map([['b', 'b']]), groupOwners: new Map([['gb', { botId: 'b', roomId: 'r' }]]),
    chatOf: () => 'b', groupSessionsOf: () => ['gb'], selfOf: id => id === 'gb' ? 'b' : id,
    isBotSession: id => ['b', 'gb'].includes(id),
    readOnly: () => undefined, load: async () => {}, warn() {},
    resolveAgent: async (id) => {
      if (!agents.has(id)) agents.set(id, { id, session: { id } })
      return agents.get(id)
    },
  }
  permissions(rt)
  approvals(rt)
  const request = async (id = 'b', extra = {}) => ({ agent: await rt.resolveAgent(id), toolName: 'bash', ...extra })
  const step = async (id = 'b', source = 'user') => ctx.listeners.get('agent/pre-step')[0](
    { agent: await rt.resolveAgent(id), messages: [{ source }], step: 1 }, async () => 'next',
  )
  return { rt, bot, room, ctx, approval, request, step, writes, audit, policies, modes, interactive: () => interactive, policyWrites: () => policyWrites }
}

test('ordinary, scheduled and group tasks automatically execute technical requests with audited outcomes', async () => {
  const host = runtime()
  for (const [id, source] of [['b', 'user'], ['b', 'schedule'], ['gb', 'group']]) {
    assert.equal(await host.step(id, source), 'next')
    assert.equal(host.modes.get(id), 'danger-full-access')
    assert.equal(host.policies.get(id), 'ask')
    for (const toolName of ['bash', 'browser_write', 'approve_agent_action', 'update_bot']) {
      assert.equal(await host.approval.request(await host.request(id, { toolName })), 'allowed-once')
    }
  }
  assert.equal(host.interactive(), 0)
  assert.equal(host.audit.length, 12)
  assert.deepEqual(host.rt.approvalsView(), [])
  assert.deepEqual(host.writes, [['b', 'danger-full-access'], ['gb', 'danger-full-access']])
  assert.equal(host.policyWrites(), 2)
})

test('enabling full delegation releases an already waiting technical approval and withdraws its card', async () => {
  const host = runtime('workspace-write')
  await host.step()
  const result = host.approval.request(await host.request())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.rt.approvalsView().length, 1)
  await host.rt.setPermission(host.bot, 'danger-full-access')
  assert.equal(await result, 'allowed-once')
  assert.deepEqual(host.rt.approvalsView(), [])
})

test('intent confirmations remain answerable while execution requests run automatically', async () => {
  const host = runtime('danger-full-access')
  await host.step()
  const result = host.rt.requestUserDecision(await host.request('b', { toolName: 'message_bot', reason: 'Share private content?' }))
  await new Promise(resolve => setImmediate(resolve))
  const [entry] = host.rt.approvalsView()
  assert.equal(entry.requiresUserDecision, true)
  host.rt.settleDelegatedApprovals('b')
  assert.equal(host.rt.approvalsView().length, 1)
  assert.equal(await host.approval.request(await host.request()), 'allowed-once')
  host.rt.answerApproval(entry.id, 'allow')
  assert.equal(await result, 'allowed-once')
  assert.deepEqual(host.rt.approvalsView(), [])
})

test('cancelled execution requests are never revived by full delegation', async () => {
  const host = runtime()
  await host.step()
  assert.equal(await host.approval.request(await host.request('b', { signal: AbortSignal.abort() })), 'cancelled')
  host.rt.settleDelegatedApprovals('b')
  assert.deepEqual(host.rt.approvalsView(), [])
})

test('explicit group restrictions and permission downgrades keep the ordinary decision path', async () => {
  const host = runtime('danger-full-access')
  await host.rt.setRoomPermission(host.room, 'read-only')
  await host.step('gb')
  assert.equal(host.modes.get('gb'), 'read-only')
  const result = host.approval.request(await host.request('gb'))
  await new Promise(resolve => setImmediate(resolve))
  const [entry] = host.rt.approvalsView()
  host.rt.settleDelegatedApprovals('gb')
  assert.equal(host.rt.approvalsView().length, 1)
  host.rt.answerApproval(entry.id, 'reject')
  assert.equal(await result, 'rejected')
  await host.rt.setPermission(host.bot, 'workspace-write')
  assert.equal(host.rt.isFullyDelegated('b'), false)
})

test('non-Bot sessions keep their existing execution policy and answerer', async () => {
  const host = runtime()
  await host.step('outside')
  assert.deepEqual(host.writes, [])
  assert.equal(host.rt.isFullyDelegated('outside'), false)
  assert.equal(host.ctx.listeners.get('approval/request')[0](await host.request('outside'), () => 'external'), 'external')
})

test('a pending or failed permission change never grants execution before the sandbox is applied', async () => {
  const host = runtime('workspace-write')
  await host.step()
  const request = await host.request()
  const resolveAgent = host.rt.resolveAgent
  let fail
  host.rt.resolveAgent = () => new Promise((_resolve, reject) => { fail = reject })
  const change = host.rt.setPermission(host.bot, 'danger-full-access')
  const refused = assert.rejects(change, /session unavailable/)
  const outcome = host.approval.request(request)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.rt.approvalsView().length, 1)
  assert.deepEqual(host.audit, [])
  host.rt.resolveAgent = resolveAgent
  fail(new Error('session unavailable'))
  await refused
  assert.equal(host.bot.permission, 'workspace-write')
  host.rt.answerApproval(host.rt.approvalsView()[0].id, 'reject')
  assert.equal(await outcome, 'rejected')
})
