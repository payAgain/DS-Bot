import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { scheduledRows, scheduleZone } from '../src/shared/scheduled-tasks.js'
import { taskOnDay } from '../src/shared/task-time.js'

const now = Date.parse('2026-11-14T12:00:00Z')
const seed = (extra = {}) => ({ id: 's1', title: 'Fixture briefing', prompt: 'Fixture instruction <script>not executable</script>', kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Shanghai:20300101T053000\nRRULE:FREQ=DAILY', scheduledAt: '2030-01-01T00:00:00Z', target: { kind: 'session', sessionId: 'm1' }, status: 'active', updatedAt: '2026-11-14T10:00:00.000Z', ...extra })
async function setup(t, { legacy = false, absent = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-schedule-board-'))
  await writeFile(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: ['m1'], revision: 0, bots: { m1: { id: 'm1', name: 'Chief', sessionId: 'm1', createdAt: 1 } }, rooms: {}, agents: {}, prefs: {} }))
  const entries = [seed(), seed({ id: 'paused', status: 'paused' }), seed({ id: 'ended', status: 'ended' }), seed({ id: 'outside', target: { kind: 'session', sessionId: 'outside' } }), seed({ id: 'new', target: { kind: 'new_once' } })]
  const mutations = []
  const schedule = { catalog: async () => structuredClone(entries) }
  if (!legacy) schedule.edit = async request => {
    mutations.push(structuredClone(request))
    const item = entries.find(entry => entry.id === request.id)
    if (!item) return { code: 'schedule_not_found', id: request.id }
    if ((item.updatedAt ?? null) !== request.expectedUpdatedAt) return { code: 'schedule_conflict', id: item.id }
    if (request.action === 'delete') { entries.splice(entries.indexOf(item), 1); return { id: item.id, deleted: true } }
    const patch = request.patch
    if (patch.active !== undefined) item.status = patch.active ? 'active' : 'paused'
    if (patch.title !== undefined) item.title = patch.title
    if (patch.prompt !== undefined) item.prompt = patch.prompt
    if (patch.timing) item.rrule = patch.timing.rrule
    item.updatedAt = new Date(Date.parse(item.updatedAt ?? '2026-01-01') + 1000).toISOString()
    return structuredClone(item)
  }
  const ctx = fakeContext({ services: absent ? {} : { schedule } })
  const reg = ctx.connection.fetch.register
  let route
  ctx.connection.fetch.register = options => { route = options; return reg(options) }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  return { call, entries, mutations, home, rt }
}

test('schedule projection preserves actual states and never inserts ordinary todos or mutates records', () => {
  const entries = [seed(), seed({ id: 'p', status: 'paused' }), seed({ id: 'e', status: 'ended' }), seed({ id: 'u', status: 'unknown' }), seed({ id: 'o', scheduledAt: '2020-01-01T00:00:00Z' }), seed({ id: 'bad', scheduledAt: 'not-a-date' })]
  const before = JSON.stringify(entries)
  const rows = scheduledRows(entries, now)
  assert.deepEqual(rows.map(row => row.status), ['scheduled', 'paused', 'finished', 'unknown', 'overdue', 'overdue'])
  assert.equal(rows.filter(row => row.start).length, 1)
  assert.ok(rows.every(row => row.kind === 'scheduled' && row.id.startsWith('schedule:')))
  assert.equal(JSON.stringify(entries), before)
})
test('next-only calendar points handle viewing zones and midnight without a fake work interval', () => {
  const [row] = scheduledRows([seed({ scheduledAt: '2026-11-14T16:00:00Z' })], now)
  assert.equal(taskOnDay(row, '2026-11-15', 'Asia/Shanghai'), true)
  assert.equal(taskOnDay(row, '2026-11-14', 'Asia/Shanghai'), false)
  assert.equal(taskOnDay(row, '2026-11-14', 'UTC'), true)
  assert.equal(Date.parse(row.end) - Date.parse(row.start), 1)
  assert.equal(taskOnDay(row, '2026-11-16', 'Asia/Shanghai'), false)
  const [expired] = scheduledRows([seed({ scheduledAt: '2026-11-14T16:00:00Z' })], Date.parse('2026-11-14T16:00:01Z'))
  assert.equal(expired.start, null)
})
test('rrule TZID and UTC resolve without using a deadline or guessing a recurrence', () => {
  assert.equal(scheduleZone(seed()), 'Asia/Shanghai')
  assert.equal(scheduleZone(seed({ timeZone: 'America/New_York' })), 'America/New_York')
  assert.equal(scheduleZone(seed({ rrule: 'DTSTART:20300101T053000Z\nRRULE:FREQ=DAILY' })), 'UTC')
})
test('workbench reads reuse existing visible catalog and never create a task file or change schedules', async t => {
  const { call, entries, mutations, home } = await setup(t)
  const before = JSON.stringify(entries)
  const original = await call('schedules')
  const view = await call('workbench-schedules')
  assert.equal(view.ok, true)
  assert.deepEqual(view.value.tasks, original.value.tasks)
  assert.deepEqual(view.value.tasks.map(task => task.id), ['s1', 'paused', 'ended'])
  assert.equal(view.value.manageable, true)
  assert.equal(JSON.stringify(entries), before)
  assert.equal(mutations.length, 0)
  await assert.rejects(readFile(join(home, 'tasks.json')), { code: 'ENOENT' })
})
test('unavailable or legacy services expose read-only state without inventing controls', async t => {
  const one = await setup(t, { absent: true })
  const view = (await one.call('workbench-schedules')).value
  assert.equal(view.available, false); assert.equal(view.manageable, false); assert.deepEqual(view.tasks, [])
  const two = await setup(t, { legacy: true })
  assert.equal((await two.call('workbench-schedules')).value.manageable, false)
  assert.equal((await two.call('workbench-schedule-edit', { id: 's1', action: 'pause', expectedUpdatedAt: null })).ok, false)
})
test('controls use native expectedUpdatedAt, refresh real state, and keep timing and target intact', async t => {
  const { call, entries, mutations } = await setup(t)
  const rule = entries[0].rrule, target = structuredClone(entries[0].target)
  let result = await call('workbench-schedule-edit', { id: 's1', action: 'pause', expectedUpdatedAt: entries[0].updatedAt })
  assert.equal(result.value.tasks[0].status, 'paused')
  assert.deepEqual(mutations[0].patch, { active: false })
  result = await call('workbench-schedule-edit', { id: 's1', action: 'resume', expectedUpdatedAt: entries[0].updatedAt })
  assert.equal(result.value.tasks[0].status, 'active')
  assert.equal(entries[0].rrule, rule); assert.deepEqual(entries[0].target, target)
  result = await call('workbench-schedule-edit', { id: 's1', action: 'update', expectedUpdatedAt: entries[0].updatedAt, fields: { title: 'Renamed fixture' } })
  assert.equal(result.value.tasks[0].title, 'Renamed fixture')
  assert.deepEqual(mutations.at(-1).patch, { title: 'Renamed fixture' })
})
test('hidden task, missing revisions, unknown actions and target changes cannot cross the management boundary', async t => {
  const { call, mutations } = await setup(t)
  for (const payload of [
    { id: 'outside', action: 'delete', expectedUpdatedAt: null },
    { id: 'new', action: 'delete', expectedUpdatedAt: null },
    { id: 's1', action: 'pause' },
    { id: 's1', action: 'run', expectedUpdatedAt: null },
    { id: 's1', action: 'update', expectedUpdatedAt: null, fields: { target: { kind: 'new' } } },
    { id: 's1', action: 'update', expectedUpdatedAt: null, fields: { active: false } },
  ]) assert.equal((await call('workbench-schedule-edit', payload)).ok, false)
  assert.equal(mutations.length, 0)
})
test('stale schedule edits/deletes do not succeed, while null legacy revisions stay guarded', async t => {
  const { call, entries } = await setup(t)
  const before = JSON.stringify(entries)
  for (const action of ['pause', 'delete']) {
    const result = await call('workbench-schedule-edit', { id: 's1', action, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' })
    assert.equal(result.ok, false); assert.equal(result.error.code, 'bot/stale')
  }
  assert.equal(JSON.stringify(entries), before)
  delete entries[0].updatedAt
  const result = await call('workbench-schedule-edit', { id: 's1', action: 'delete', expectedUpdatedAt: null })
  assert.equal(result.ok, true); assert.equal(result.value.tasks.some(task => task.id === 's1'), false)
})
test('read-only team protection still permits catalog reads but refuses control operations', async t => {
  const { call, rt, mutations } = await setup(t)
  rt.readOnly = () => 'Fixture read only'
  assert.equal((await call('workbench-schedules')).ok, true)
  assert.equal((await call('workbench-schedule-edit', { id: 's1', action: 'pause', expectedUpdatedAt: null })).error.code, 'bot/read-only')
  assert.equal(mutations.length, 0)
})
