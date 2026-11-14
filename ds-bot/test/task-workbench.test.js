import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanTask, createTaskStore, install } from '../src/host/tasks.js'
import { addDays, cleanSchedule, dayInZone, instantFromWall, taskOnDay, validDate } from '../src/shared/task-time.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const bots = { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } }
const fields = { title: 'Plan a visit', timeZone: 'Asia/Shanghai' }
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-tasks-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const path = join(home, 'tasks.json')
  return { home, path, store: createTaskStore(path, { bots: () => bots }) }
}
test('empty store has no samples and reading does not create data', async t => {
  const { path, store } = await fixture(t)
  assert.deepEqual(await store('list'), { revision: 0, tasks: [] })
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})
test('persistent create, update, restart and delete use the same tasks', async t => {
  const { path, store } = await fixture(t)
  const { task } = await store('create', { fields })
  assert.equal(task.kind, 'personal'); assert.equal(task.ownerId, null)
  const second = createTaskStore(path, { bots: () => bots })
  assert.equal((await second('list')).tasks[0].title, fields.title)
  const changed = await store('update', { id: task.id, expectedRevision: 1, fields: { kind: 'bot', ownerId: 'b', status: 'doing', start: '2026-11-14T09:00:00+08:00', end: '2026-11-14T10:00:00+08:00' } })
  assert.equal(changed.task.start, '2026-11-14T01:00:00.000Z')
  assert.equal((await second('list')).tasks[0].revision, 2)
  await store('delete', { id: task.id, expectedRevision: 2 })
  assert.deepEqual((await second('list')).tasks, [])
})
test('simultaneous edits allow one winner and reject stale writes and deletes', async t => {
  const { store } = await fixture(t)
  const { task } = await store('create', { fields })
  const results = await Promise.allSettled(['one', 'two'].map(title => store('update', { id: task.id, expectedRevision: task.revision, fields: { title } })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'bot/stale')
  await assert.rejects(store('delete', { id: task.id, expectedRevision: 1 }), { code: 'bot/stale' })
})
test('read-only mode and malformed storage preserve the original data', async t => {
  const { path } = await fixture(t)
  const readonly = createTaskStore(path, { writable: () => { throw new Error('read only') } })
  await assert.rejects(readonly('create', { fields }), /read only/)
  await writeFile(path, '{broken')
  await assert.rejects(readonly('create', { fields }))
  assert.equal(await readFile(path, 'utf8'), '{broken')
})
test('validates owners, links, fields, dates and bounded text without coercion', () => {
  for (const input of [{ title: '' }, { title: 3 }, { title: 'x', kind: 'bot', ownerId: '__proto__' }, { title: 'x', status: 'bogus' }, { title: 'x', conversationId: 'unknown' }, { title: 'x', due: '2026-02-30' }, { title: 'x', results: [{ label: 'x', url: 'javascript:alert(1)' }] }, { title: 'x', results: [{ label: 'x', url: 'https://name@example.com' }] }, { title: 'x', results: [{ label: '', url: 'https://example.com' }] }, { title: 'x', mystery: true }]) assert.throws(() => cleanTask(input, undefined, bots, {}))
  const task = cleanTask({ ...fields, conversationId: 'a', results: [{ label: 'Report', url: 'https://example.com/report' }] }, undefined, bots, {})
  assert.equal(task.results.length, 1)
})
test('deadlines do not book calendar time; clearing time removes calendar membership', () => {
  const task = cleanTask({ ...fields, due: '2026-11-14' }, undefined, bots, {})
  assert.equal(taskOnDay(task, '2026-11-14', 'Asia/Shanghai'), false)
  const timed = cleanTask({ ...fields, start: '2026-11-14T09:00:00Z', end: '2026-11-14T10:00:00Z' }, undefined, bots, {})
  assert.equal(taskOnDay(timed, '2026-11-14', 'UTC'), true)
  const cleared = cleanTask({ start: null, end: null }, timed, bots, {})
  assert.equal(taskOnDay(cleared, '2026-11-14', 'UTC'), false)
  assert.throws(() => cleanTask({ start: null }, timed, bots, {}), /both required/)
})
test('all-day dates are zone-independent, span days and exclude the end', () => {
  const task = cleanSchedule({ timeZone: 'Asia/Shanghai', allDay: true, start: '2026-11-14', end: '2026-11-16' })
  for (const zone of ['UTC', 'America/New_York', 'Pacific/Auckland']) {
    assert.equal(taskOnDay(task, '2026-11-14', zone), true)
    assert.equal(taskOnDay(task, '2026-11-15', zone), true)
    assert.equal(taskOnDay(task, '2026-11-16', zone), false)
  }
})
test('cross-midnight intervals, midnight end and viewing zone produce correct days', () => {
  const task = cleanSchedule({ timeZone: 'Asia/Shanghai', allDay: false, start: '2026-11-14T23:00:00+08:00', end: '2026-11-15T01:00:00+08:00' })
  assert.equal(taskOnDay(task, '2026-11-14', 'Asia/Shanghai'), true)
  assert.equal(taskOnDay(task, '2026-11-15', 'Asia/Shanghai'), true)
  assert.equal(taskOnDay(task, '2026-11-15', 'UTC'), false)
  const midnight = { ...task, end: '2026-11-14T16:00:00Z' }
  assert.equal(taskOnDay(midnight, '2026-11-15', 'Asia/Shanghai'), false)
})
test('rejects inverted intervals, missing offsets, invalid zone and calendar overflow', () => {
  for (const task of [
    { start: '2026-11-14T10:00:00Z', end: '2026-11-14T09:00:00Z' },
    { start: '2026-11-14T09:00', end: '2026-11-14T10:00' },
    { start: '2026-02-30T09:00Z', end: '2026-03-01T10:00Z' },
    { allDay: true, start: '2026-11-14', end: '2026-11-14' },
    { timeZone: 'not/a-zone' },
  ]) assert.throws(() => cleanSchedule({ timeZone: 'UTC', ...task }))
  assert.equal(validDate('2026-02-30'), false)
  assert.equal(addDays('2028-02-28', 1), '2028-02-29')
})
test('wall-clock conversion handles named zones and rejects skipped/repeated DST times', () => {
  assert.equal(instantFromWall('2026-11-14T09:30', 'Asia/Shanghai'), '2026-11-14T01:30:00.000Z')
  assert.equal(dayInZone('2026-11-14T23:00Z', 'Asia/Tokyo'), '2026-11-15')
  assert.throws(() => instantFromWall('2026-03-08T02:30', 'America/New_York'), /skipped or repeated/)
  assert.throws(() => instantFromWall('2026-11-01T01:30', 'America/New_York'), /skipped or repeated/)
  assert.equal(instantFromWall('2026-03-08T03:30', 'America/New_York'), '2026-03-08T07:30:00.000Z')
})
test('registered Bot tool shares persistence and hides private-linked tasks', async t => {
  const { home } = await fixture(t)
  const state = { bots: { ...bots, p: { id: 'p', private: true } }, rooms: {}, privateArchives: [] }
  const rt = { home, state, teamTools: [], load: async () => {}, readOnly: () => undefined, selfOf: id => id, botOf: id => state.bots[id] }
  install(rt)
  await rt.taskEndpoint('create', { fields: { ...fields, kind: 'bot', ownerId: 'p' } })
  const tool = rt.teamTools.find(tool => tool.name === 'task_workbench')
  const execute = (args, id = 'a') => tool.execute(args, { agent: { id } }).then(JSON.parse)
  assert.deepEqual((await execute({ action: 'list' })).tasks, [])
  assert.equal((await execute({ action: 'list' }, 'p')).tasks.length, 1)
  const created = await execute({ action: 'create', fields })
  assert.equal((await rt.taskEndpoint('list')).tasks.length, 2)
  const updated = await execute({ action: 'update', id: created.task.id, expectedRevision: 1, fields: { status: 'review' } })
  assert.equal(updated.task.status, 'review')
  const forbidden = await execute({ action: 'create', fields }, 'p')
  assert.equal(forbidden.code, 'bot/refused')
})
test('real runtime registers task endpoint and Bot scoped tool without starting work', async t => {
  const { home } = await fixture(t)
  await writeFile(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: ['a'], bots, rooms: {}, agents: {}, prefs: {}, revision: 0 }))
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [], listModels: async () => [] }, workspaceRegistry: { get: () => undefined }, sessions: { flush: async () => {} }, sessionTitle: {}, sessionController: {} })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  t.after(() => ctx.dispose())
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  assert.equal((await call('tasks-list')).value.tasks.length, 0)
  const created = await call('tasks-create', { fields })
  assert.equal(created.ok, true)
  assert.ok(rt.teamTools.some(tool => tool.name === 'task_workbench'))
  assert.equal((await call('tasks-list')).value.tasks[0].id, created.value.task.id)
  assert.deepEqual(Object.keys(rt.state.works ?? {}), [])
})
