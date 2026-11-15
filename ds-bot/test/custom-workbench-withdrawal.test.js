import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-withdraw-'))
  const retained = JSON.stringify({ version: 1, revision: 4, tasks: [{ id: 'retained-fixture', title: 'Preserved data' }] })
  await writeFile(join(home, 'tasks.json'), retained)
  await writeFile(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: ['m1'], bots: { m1: { id: 'm1', name: 'Chief', sessionId: 'm1', createdAt: 1 } }, rooms: {}, agents: {}, prefs: {}, revision: 0 }))
  let mutations = 0
  const schedule = { catalog: async () => [{ id: 'schedule-fixture', title: 'Fixture schedule', prompt: 'Fixture only', status: 'paused', kind: 'rrule', rrule: 'DTSTART:20300101T090000Z\nRRULE:FREQ=DAILY', scheduledAt: '2030-01-01T09:00:00Z', target: { kind: 'session', sessionId: 'm1' } }], edit: async () => { mutations += 1; throw Error('No schedule mutation expected') }, create: async () => { mutations += 1; throw Error('No schedule creation expected') } }
  const ctx = fakeContext({ services: { schedule } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  const call = async endpoint => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload: {} }) }))).json()
  t.after(async () => {
    await ctx.dispose()
    assert.equal(await readFile(join(home, 'tasks.json'), 'utf8'), retained)
    assert.ok(home.startsWith(join(tmpdir(), 'ds-bot-withdraw-')))
    await rm(home, { recursive: true, force: true })
  })
  return { rt, call, home, retained, mutations: () => mutations }
}

test('custom workbench tool and API routes are withdrawn while group tools remain registered', async t => {
  const { rt, call, mutations } = await setup(t)
  assert.equal(rt.teamTools.some(tool => tool.name === 'task_workbench'), false)
  assert.ok(rt.teamTools.some(tool => tool.name === 'group_task'))
  assert.ok(rt.teamTools.some(tool => tool.name === 'group_goal'))
  for (const endpoint of ['tasks-list', 'tasks-create', 'tasks-update', 'tasks-delete', 'workbench-schedules', 'workbench-schedule-edit']) {
    const result = await call(endpoint)
    assert.equal(result.ok, false, endpoint)
    assert.equal(result.error.code, 'bot/not-found', endpoint)
  }
  assert.equal(mutations(), 0)
})
test('the original schedule catalog and retained ordinary task data survive withdrawal without mutation', async t => {
  const { call, home, retained, mutations } = await setup(t)
  const result = await call('schedules')
  assert.equal(result.ok, true)
  assert.equal(result.value.available, true)
  assert.equal(result.value.tasks.length, 1)
  assert.equal(result.value.tasks[0].status, 'paused')
  assert.equal(await readFile(join(home, 'tasks.json'), 'utf8'), retained)
  assert.equal(mutations(), 0)
})
test('the generated client no longer contains the custom workspace entry, calendar or schedule integration', async () => {
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  for (const marker of ['bt-wb-entry', 'bt-wb-workbench', 'Task workbench', 'workbench-schedules', 'workbench-schedule-edit']) assert.equal(client.includes(marker), false, marker)
  assert.ok(client.includes('Scheduled tasks'))
  assert.ok(client.includes('group_task') || client.includes('TaskBoard'))
})
