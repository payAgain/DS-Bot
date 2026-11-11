// The result of work a Bot handed on, when it is longer than state.json keeps: the
// whole result has to survive a restart, so the Bot that asked for it gets all of it.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { scopeTarget } from '@deepseek-ai/dsh-scope'

let rt

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
    d: { id: 'd', name: 'Editor', role: 'Edit', sessionId: 'd', createdAt: 4 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// A host over the plugin's own folder. Starting the same folder again is a restart:
// the first host is closed before the second one starts.
async function startHost(home, team, options = {}) {
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const agents = options.agents ?? new Map()
  const histories = options.histories ?? new Map()
  const ctx = fakeContext({ services: { agents: { list: () => [...agents.values()] } } })
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
      inspect: async id => ({ events: histories.get(id) ?? [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  let seq = Math.max(0, ...[...histories.values()].flat().map(event => event.seq))
  const emit = (id, type, data) => {
    const event = { type, seq: ++seq, data, time: Date.now() }
    histories.set(id, [...(histories.get(id) ?? []), event])
    if (type === 'turn/start') agentOf(id).status = 'running'
    if (type === 'turn/end') agentOf(id).status = 'idle'
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, event)
    }
  }
  // Scoped Cordis events (subagent lifecycle, tool results) reach the plugin
  // through a dispatch carrier DSH keys by the agent the event is for — that
  // carrier is what `this` is in a real listener call.
  const emitScoped = (parentId, name, ...args) => {
    const carrier = scopeTarget({}, agentOf(parentId))
    for (const listener of ctx.listeners.get(name) ?? []) listener.call(carrier, ...args)
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { rt, ctx, agents, histories, agentOf, emit, emitScoped, tool, call, home, stop: () => ctx.dispose() }
}

// The plugin folder of a test, and the hosts over it. A second host over the same
// folder is a restart. Everything is closed and removed when the test ends.
function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-handoff-results-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, start: async (team, options) => { const host = await startHost(home, team, options); hosts.push(host); return host } }
}

const textBlock = content => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })
const callsOf = (agents, id) => agents.get(id)?.calls ?? []
const settled = async (check) => {
  for (let count = 0; count < 200 && !check(); count += 1) await delay(5)
}

// Each Session takes up the newest message it was sent as its next turn.
function turnTaker(agents, emit) {
  const turns = new Map()
  const open = (id, message) => {
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const take = id => open(id, agents.get(id).calls.at(-1)[1])
  const end = (id, text) => {
    if (text !== undefined) emit(id, 'assistant/message', assistantText(text))
    emit(id, 'turn/end', { turn: turns.get(id), reason: { kind: 'completed' } })
  }
  const userTurn = (id, text) => {
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: textBlock(text), source: { kind: 'user' } })
  }
  return { take, open, end, userTurn }
}

// The works the team file holds, once the saves made so far are done.
const worksIn = async ({ call, home }) => {
  await call('set-prefs', {})
  return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).works ?? {}
}


test('reload preserves the original trigger and defers a mid-turn request instead of losing it', async t => {
  const { start } = bench(t)
  const first = await start(seed())
  const turns = turnTaker(first.agents, first.emit)
  turns.userTurn('a', 'ask writer')
  await first.tool('message_bot', { to: 'Writer', message: 'original work' }, 'a')
  turns.end('a', 'sent')
  turns.take('b')
  turns.userTurn('c', 'send a separate request')
  await first.tool('message_bot', { to: 'Writer', message: 'separate work' }, 'c')
  const joined = first.agents.get('b').calls.at(-1)[1]
  first.emit('b', 'user/message', joined)
  const original = first.rt.live.get('b').info.exchangeId
  await first.stop()
  const second = await start(undefined, { agents: first.agents, histories: first.histories })
  await second.rt.adoptLiveWork()
  assert.equal(second.rt.live.get('b').info.exchangeId, original)
  assert.equal(second.rt.live.get('b').joined[0].info.exchangeId, joined.source.exchangeId)
  second.emit('b', 'assistant/message', assistantText('original result'))
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled(() => callsOf(second.agents, 'a').some(([, message]) => message.source?.replyTo === original))
  assert.equal(callsOf(second.agents, 'c').some(([, message]) => message.source?.replyTo === joined.source.exchangeId), false)
  const deferred = callsOf(second.agents, 'b').at(-1)[1]
  assert.equal(deferred.source.deferred, true)
  const again = turnTaker(second.agents, second.emit)
  again.open('b', deferred)
  again.end('b', 'separate result')
  await settled(() => callsOf(second.agents, 'c').some(([, message]) => message.source?.replyTo === joined.source.exchangeId))
  assert.equal(second.rt.statusOf('b'), 'idle')
  assert.deepEqual(await worksIn(second), {})
})

test('one-way information never creates a dependency or routes a reply', async t => {
  const { start } = bench(t)
  const host = await start(seed())
  const turns = turnTaker(host.agents, host.emit)
  turns.userTurn('a', 'coordinate')
  const receipt = await host.tool('message_bot', { to: 'Writer', message: 'deployment is complete', reply_to: 'none' }, 'a')
  assert.match(receipt, /No reply or handback/)
  assert.deepEqual(await worksIn(host), {})
  turns.end('a', 'done')
  turns.take('b')
  turns.end('b', 'noted')
  assert.equal(callsOf(host.agents, 'a').length, 0)
  assert.equal(host.rt.statusOf('b'), 'idle')
})

test('a work cannot be sent back to its waiting ancestor, but independent work can proceed', async t => {
  const { start } = bench(t)
  const host = await start(seed())
  const turns = turnTaker(host.agents, host.emit)
  turns.userTurn('a', 'coordinate')
  await host.tool('message_bot', { to: 'Writer', message: 'do it' }, 'a')
  turns.end('a', 'sent')
  turns.take('b')
  const reply = await host.tool('message_bot', { to: 'Chief', message: 'ask again' }, 'b')
  assert.match(reply, /Not sent/)
  assert.equal(callsOf(host.agents, 'a').length, 0)
  turns.end('b', 'done')
  await settled(() => callsOf(host.agents, 'a').length === 1)
  assert.equal(host.rt.statusOf('b'), 'idle')
})

for (const kind of ['error', 'aborted']) test(`a ${kind} turn settles its request exactly once`, async t => {
  const { start } = bench(t)
  const host = await start(seed())
  const turns = turnTaker(host.agents, host.emit)
  turns.userTurn('a', 'coordinate')
  await host.tool('message_bot', { to: 'Writer', message: 'do it' }, 'a')
  turns.end('a', 'sent')
  turns.take('b')
  const source = host.rt.live.get('b').info
  host.emit('b', 'turn/end', { turn: 1, reason: kind === 'error' ? { kind, error: { code: 'TEST', message: 'fixture failure' } } : { kind, reason: { kind: 'user' } } })
  await settled(() => callsOf(host.agents, 'a').length === 1)
  const { answerSender } = await import('../src/host/turns.js')
  answerSender(host.rt, 'b', source, 'duplicate terminal event')
  await Promise.resolve()
  assert.equal(callsOf(host.agents, 'a').length, 1)
  assert.deepEqual(await worksIn(host), {})
})

test('audited release targets one idle read notification and preserves real waits', async t => {
  const { start } = bench(t)
  const host = await start(seed())
  host.rt.openWork('parent', { from: 'a', to: 'b' })
  host.rt.openWork('notice', { from: 'b', to: 'c', parent: 'parent' })
  host.rt.openWork('real', { from: 'b', to: 'd', parent: 'parent' })
  const args = { id: 'notice', parent: 'parent', reason: 'Both parties confirmed this was a historical notification with no pending business task.' }
  host.agentOf('c').status = 'running'
  assert.equal((await host.call('resolve-handoff', args)).ok, false)
  host.agentOf('c').status = 'idle'
  assert.equal((await host.call('resolve-handoff', { ...args, parent: 'wrong' })).ok, false)
  assert.equal((await host.call('resolve-handoff', args)).ok, true)
  assert.deepEqual(host.rt.state.works.parent.open, ['real'])
  assert.ok(host.rt.waitingView().b)
  const count = callsOf(host.agents, 'b').length
  assert.equal((await host.call('resolve-handoff', args)).value.alreadySettled, true)
  assert.equal(callsOf(host.agents, 'b').length, count)
  assert.equal(host.rt.state.settledWorks.notice.resolution, 'notification')
})
