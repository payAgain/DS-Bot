import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../src/host/handoffs.js'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'handoff-maintenance-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const deliveries = []
  const agent = { status: 'idle', inbox: { nextStep: [], nextTurn: [] } }
  const rt = {
    home, state: {}, live: new Map(), groupOwners: new Map(),
    save: async () => {}, readOnly: () => undefined,
    botOf: id => ({ name: id }), chatOf: id => id,
    groupSessionsOf: () => [], roomOf: () => undefined,
    resolveAgent: async () => agent,
    deliver: async message => deliveries.push(message),
  }
  install(rt)
  rt.openWork('root', { from: 'chief', to: 'mac' })
  rt.openWork('notice', { from: 'mac', to: 'ops', parent: 'root' })
  return { rt, agent, deliveries }
}
const reason = 'Reviewed by the coordinator: this historical notice has no outstanding business work.'

test('reviewed notices can be released without invoking a suspended Bot', async t => {
  const { rt, deliveries } = fixture(t)
  rt.openWork('other-root', { from: 'chief', to: 'ops' })
  rt.openWork('other-notice', { from: 'ops', to: 'mac', parent: 'other-root' })
  assert.match(rt.statusOf('mac'), /waiting for ops/)
  assert.match(rt.statusOf('ops'), /waiting for mac/)
  for (const [id, parent] of [['notice', 'root'], ['other-notice', 'other-root']]) {
    assert.deepEqual(await rt.resolveHandoff({ id, parent, reason, notify: false }), { id, released: true, notified: false })
    assert.equal(rt.state.settledWorks[id].notified, false)
    assert.equal(rt.state.works[parent].results.length, 1)
    assert.match(rt.state.works[parent].results[0].text, /does not claim task execution succeeded/)
  }
  assert.equal(rt.statusOf('mac'), 'idle')
  assert.equal(rt.statusOf('ops'), 'idle')
  assert.equal(deliveries.length, 0)
  assert.equal((await rt.resolveHandoff({ id: 'notice', parent: 'root', reason, notify: false })).alreadySettled, true)
  assert.equal(deliveries.length, 0)
})

test('silent maintenance preserves other live waits and refuses unread requests', async t => {
  const { rt, agent, deliveries } = fixture(t)
  rt.openWork('real', { from: 'mac', to: 'worker', parent: 'root' })
  agent.inbox.nextStep.push({ source: { exchangeId: 'notice' } })
  await assert.rejects(rt.resolveHandoff({ id: 'notice', parent: 'root', reason, notify: false }), /has not read/)
  agent.inbox.nextStep = []
  await rt.resolveHandoff({ id: 'notice', parent: 'root', reason, notify: false })
  assert.deepEqual(rt.state.works.root.open, ['real'])
  assert.match(rt.statusOf('mac'), /waiting for worker/)
  assert.equal(deliveries.length, 0)
})

test('maintenance refuses changed parent and malformed notification mode', async t => {
  const { rt } = fixture(t)
  await assert.rejects(rt.resolveHandoff({ id: 'notice', parent: 'other', reason, notify: false }), /changed/)
  await assert.rejects(rt.resolveHandoff({ id: 'notice', parent: 'root', reason, notify: 'false' }), /boolean/)
  assert.deepEqual(rt.state.works.root.open, ['notice'])
})
