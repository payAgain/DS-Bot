import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { scheduledRows } from '../src/shared/scheduled-tasks.js'
import { DICTIONARY } from '../src/client/i18n.js'

const { outputFiles } = await build({
  stdin: { contents: "export * from './src/client/schedule-workbench.js'; export {TaskWorkbench} from './src/client/task-workbench.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children)
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
  return predicate(node) ? node : find(node.props?.children, predicate)
}
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node) === label)
const tick = () => new Promise(resolve => setImmediate(resolve))
function harness() {
  let cursor = 0
  const cells = [], effects = [], timers = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(value) { const id = cursor++; if (!(id in cells)) cells[id] = typeof value === 'function' ? value() : value; return [cells[id], next => { cells[id] = typeof next === 'function' ? next(cells[id]) : next }] },
    useRef(value) { const id = cursor++; return cells[id] ??= { current: value } },
    useEffect(effect) { const id = cursor++; if (!(id in cells)) { cells[id] = true; effects.push(effect) } },
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react, Intl, Date, URL, console, document: { activeElement: null }, requestAnimationFrame: () => {}, setInterval: fn => { timers.push(fn); return 1 }, clearInterval() {}, setTimeout: fn => { timers.push(fn); return 1 }, clearTimeout() {} })
  return { api: module.exports, render(Component, props) { cursor = 0; return Component(props) }, effects, timers }
}
const roster = { bots: [{ id: 'm1', name: 'Chief' }], rooms: [] }
const entry = { id: 's1', title: 'Fixture schedule', prompt: '<script>not executable</script>', kind: 'rrule', rrule: 'DTSTART:20300101T090000Z\nRRULE:FREQ=DAILY', scheduledAt: '2030-01-01T09:00:00Z', status: 'active', botId: 'm1', updatedAt: '2026-11-14T00:00:00Z' }
const row = () => scheduledRows([entry])[0]

test('schedule controls preserve native revisions and refresh only the original schedule catalog', async () => {
  const h = harness(), calls = [], changed = []
  const props = { task: row(), roster, manageable: true, request: async (endpoint, payload) => { calls.push([endpoint, payload]); return { tasks: [], manageable: true, available: true } }, onChanged: value => changed.push(value), onClose() {}, onEditing() {}, actions: {} }
  let tree = h.render(h.api.ScheduleDetail, props)
  assert.ok(text(tree).includes('<script>not executable</script>'))
  button(tree, 'Pause schedule').props.onClick()
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'workbench-schedule-edit')
  assert.equal(calls[0][1].action, 'pause')
  assert.equal(calls[0][1].expectedUpdatedAt, entry.updatedAt)
  assert.equal(changed.length, 1)
  assert.ok(calls.every(([endpoint]) => !endpoint.startsWith('tasks-') && !endpoint.includes('create')))
})
test('read-only and unavailable controls cannot dispatch native edits', async () => {
  for (const props of [{ manageable: false, roster }, { manageable: true, roster: { ...roster, readOnly: 'other host' } }]) {
    const h = harness(), calls = []
    const tree = h.render(h.api.ScheduleDetail, { ...props, task: row(), request: async (...args) => calls.push(args), actions: {}, onEditing() {} })
    const pause = button(tree, 'Pause schedule')
    assert.equal(pause.props.disabled, true)
    pause.props.onClick(); await tick()
    assert.equal(calls.length, 0)
  }
})
test('deletion requires its explicit control and captures null legacy revisions', async () => {
  const h = harness(), calls = []
  const task = row(); task.schedule = { ...task.schedule, updatedAt: undefined }
  const props = { task, roster, manageable: true, request: async (...args) => { calls.push(args); return { tasks: [] } }, actions: {}, onChanged() {}, onClose() {}, onEditing() {} }
  let tree = h.render(h.api.ScheduleDetail, props)
  assert.equal(button(tree, 'Confirm delete'), undefined)
  button(tree, 'Delete schedule').props.onClick()
  assert.equal(calls.length, 0)
  tree = h.render(h.api.ScheduleDetail, props)
  assert.ok(button(tree, 'Confirm delete'))
  button(tree, 'Confirm delete').props.onClick(); await tick()
  assert.equal(calls[0][1].expectedUpdatedAt, null)
  assert.equal(calls[0][1].action, 'delete')
})
test('an open editor keeps the revision it read rather than adopting a later poll', async () => {
  const h = harness(), calls = [], task = row()
  const props = { task, roster, manageable: true, request: async (...args) => { calls.push(args); throw Error('stale fixture') }, actions: {}, onChanged() {}, onClose() {}, onEditing() {} }
  let tree = h.render(h.api.ScheduleDetail, props)
  button(tree, 'Edit schedule').props.onClick()
  tree = h.render(h.api.ScheduleDetail, props)
  const input = find(tree, node => node.type === 'input')
  input.props.onChange({ target: { value: 'Changed fixture name' } })
  const newer = { ...props, task: { ...task, schedule: { ...task.schedule, updatedAt: '2026-11-15T00:00:00Z' } } }
  tree = h.render(h.api.ScheduleDetail, newer)
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await tick()
  assert.equal(calls[0][1].expectedUpdatedAt, entry.updatedAt)
  assert.equal(calls[0][1].fields.title, 'Changed fixture name')
  tree = h.render(h.api.ScheduleDetail, newer)
  assert.ok(text(tree).includes('stale fixture'))
})
test('workbench fetches ordinary and scheduled sources separately and links to the original manager', async () => {
  const h = harness(), reads = [], actions = []
  const props = { roster, initialZone: 'UTC', initialToday: '2026-11-14', request: async endpoint => { reads.push(endpoint); return endpoint === 'tasks-list' ? { revision: 0, tasks: [] } : { available: true, manageable: true, tasks: [entry] } }, actions: {} }
  h.render(h.api.TaskWorkbench, props)
  for (const effect of h.effects) effect()
  await tick()
  const tree = h.render(h.api.TaskWorkbench, props)
  assert.ok(reads.includes('tasks-list')); assert.ok(reads.includes('workbench-schedules'))
  assert.ok(text(tree).includes('Fixture schedule'))
  const detail = harness()
  const view = detail.render(detail.api.ScheduleDetail, { task: row(), roster, manageable: true, request() {}, onEditing() {}, actions: { closeTasks: () => actions.push('close'), openSettings: (...args) => actions.push(args) } })
  button(view, 'Open original schedule manager').props.onClick()
  assert.equal(actions[0], 'close'); assert.equal(actions[1][0], 'schedules'); assert.equal(actions[1][1], 'bot:m1')
})
test('a catalog poll from before a successful change cannot replace the refreshed schedule state', async () => {
  const h = harness()
  let scheduleReads = 0, releaseOld
  const props = { roster, initialZone: 'UTC', initialToday: '2026-11-14', actions: {}, request: async endpoint => {
    if (endpoint === 'tasks-list') return { revision: 0, tasks: [] }
    scheduleReads += 1
    if (scheduleReads === 2) return new Promise(resolve => { releaseOld = resolve })
    return { available: true, manageable: true, tasks: [entry] }
  } }
  h.render(h.api.TaskWorkbench, props)
  for (const effect of h.effects) effect()
  await tick()
  let tree = h.render(h.api.TaskWorkbench, props)
  find(tree, node => node.type === 'button' && node.props.className === 'bt-wb-card').props.onClick()
  tree = h.render(h.api.TaskWorkbench, props)
  const detail = find(tree, node => node.type === h.api.ScheduleDetail)
  assert.ok(detail)
  const oldPoll = h.timers.at(-1)()
  await tick()
  detail.props.onChanged({ available: true, manageable: true, tasks: [{ ...entry, status: 'paused' }] })
  releaseOld({ available: true, manageable: true, tasks: [entry] })
  await oldPoll
  tree = h.render(h.api.TaskWorkbench, props)
  assert.ok(text(tree).includes('Paused'))
  assert.equal(text(tree).includes('Enabled'), false)
})

test('schedule labels and coverage copy have translations in every supported locale', () => {
  const keys = ['Scheduled task', 'Ordinary tasks', 'Next delivery', 'Latest delivery', 'Awaiting delivery', 'Unknown schedule state', 'Delivered; queued or running', 'Delivered to the conversation', 'No saved delivery receipt', 'A delivery receipt does not mean the task finished.', 'Scheduled instruction', 'Recurrence rule', 'Save schedule', 'Edit schedule', 'Pause schedule', 'Resume schedule', 'Delete schedule', 'Delete this scheduled task and its delivery history?', 'Open original schedule manager', hCoverage()]
  function hCoverage() { return 'Scheduled tasks show only their next future delivery, not every recurrence or a booked duration.' }
  for (const [locale, dictionary] of Object.entries(DICTIONARY)) for (const key of keys) assert.equal(typeof dictionary[key], 'string', `${locale}: ${key}`)
})
