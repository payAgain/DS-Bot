import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { replaceFile } from './files.js'
import { output } from './tools.js'
import { cleanSchedule, TASK_STATUSES, validDate } from '../shared/task-time.js'

const fail = (text, code = 'bot/invalid') => Object.assign(new Error(text), { code })
const FIELDS = ['title', 'description', 'kind', 'ownerId', 'status', 'start', 'end', 'allDay', 'timeZone', 'due', 'waiting', 'conversationId', 'results']
function text(value, max, name) {
  if (typeof value !== 'string' || value.length > max) throw fail(`${name}: expected text of at most ${max} characters.`)
  return value.trim()
}
export function cleanTask(input, previous, bots, rooms, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Expected task fields.')
  if (Object.keys(input).some(key => !FIELDS.includes(key))) throw fail('Unknown task field.')
  let task = { title: '', description: '', kind: 'personal', ownerId: null, status: 'todo', start: null, end: null, allDay: false, timeZone: 'UTC', due: null, waiting: '', conversationId: null, results: [], ...previous, ...input }
  task.title = text(task.title, 200, 'title')
  if (!task.title) throw fail('A task title is required.')
  task.description = text(task.description, 12000, 'description')
  task.waiting = text(task.waiting, 1000, 'waiting')
  if (!['personal', 'bot'].includes(task.kind) || !TASK_STATUSES.includes(task.status)) throw fail('Unknown task kind or status.')
  if (typeof task.allDay !== 'boolean') throw fail('allDay must be a boolean.')
  if (task.kind === 'personal') task.ownerId = null
  else if (typeof task.ownerId !== 'string' || !Object.hasOwn(bots, task.ownerId)) throw fail('Choose a current Bot as owner.')
  if (task.conversationId !== null) {
    const owners = [...Object.values(bots), ...Object.values(rooms)]
    if (typeof task.conversationId !== 'string' || !owners.some(owner => owner.id === task.conversationId)) throw fail('Link a current Bot or group conversation by its stable ID.')
  }
  if (task.due !== null && !validDate(task.due)) throw fail('Deadline must be a valid YYYY-MM-DD date or null.')
  if (!Array.isArray(task.results) || task.results.length > 20) throw fail('At most 20 result links.')
  task.results = task.results.map(item => {
    if (!item || typeof item !== 'object') throw fail('Invalid result link.')
    const label = text(item.label, 200, 'result label')
    const url = text(item.url, 2000, 'result URL')
    let parsed
    try { parsed = new URL(url) } catch { throw fail('Result links must be HTTP or HTTPS URLs.') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !label) throw fail('Result links must have a label and an HTTP or HTTPS URL without credentials.')
    return { label, url: parsed.href }
  })
  try { task = cleanSchedule(task) } catch (error) { throw fail(error.message) }
  return { ...task, id: previous?.id ?? `task-${randomUUID()}`, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now }
}

// One queue covers read/validate/write, so concurrent edits cannot pass the same
// revision check. The team lock also excludes a second host on this data folder.
export function createTaskStore(path, { writable = () => {}, bots = () => ({}), rooms = () => ({}) } = {}) {
  let queue = Promise.resolve()
  const run = fn => {
    const result = queue.then(fn)
    queue = result.catch(() => {})
    return result
  }
  const read = async () => {
    try {
      const data = JSON.parse(await readFile(path, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.tasks)) throw fail('Task data format is not supported; original file preserved.')
      return data
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, revision: 0, tasks: [] }
      throw error
    }
  }
  return (action, args = {}, guard = () => true) => run(async () => {
    const data = await read()
    if (action === 'list') return { revision: data.revision, tasks: data.tasks.filter(guard) }
    writable()
    const old = data.tasks.find(task => task.id === args.id)
    if (action !== 'create' && (!old || !guard(old))) throw fail('Task not found.', 'bot/not-found')
    if (action !== 'create' && args.expectedRevision !== old.revision) throw fail('This task changed elsewhere. Reload before editing.', 'bot/stale')
    let task
    if (action === 'delete') data.tasks = data.tasks.filter(item => item.id !== args.id)
    else if (action === 'create' || action === 'update') {
      if (action === 'create' && data.tasks.length >= 10000) throw fail('Task limit reached (10000).')
      task = cleanTask(args.fields, action === 'update' ? old : undefined, bots(), rooms())
      if (!guard(task)) throw fail('This task is outside your task access.', 'bot/refused')
      data.tasks = action === 'create' ? [...data.tasks, task] : data.tasks.map(item => item.id === task.id ? task : item)
    } else throw fail('Unknown task action.')
    data.revision += 1
    await mkdir(join(path, '..'), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 })
    writable()
    await replaceFile(temp, path, writable)
    return { revision: data.revision, ...(task ? { task } : { deleted: args.id }) }
  })
}

export function install(rt) {
  const tasks = createTaskStore(join(rt.home, 'tasks.json'), {
    writable: () => { const reason = rt.readOnly(); if (reason) throw fail(reason, 'bot/read-only') },
    bots: () => rt.state.bots, rooms: () => rt.state.rooms,
  })
  rt.taskEndpoint = async (action, args) => { await rt.load(); return tasks(action, args) }
  const privateOwner = task => [task.ownerId, task.conversationId].filter(id => id && (rt.botOf(id)?.private || rt.state.privateArchives?.some(bot => bot.id === id)))
  rt.teamTools.push(defineTool({
    name: 'task_workbench',
    description: 'Read and maintain the user’s persistent task board and calendar. List before updating or deleting; supply the returned revision. A planned interval is separate from a deadline. Does not run Bots, create schedules or import chats. Change tasks only within the user’s request. Personal tasks have ownerId null; Bot tasks use the exact Bot ID. Conversation links use stable Bot/group IDs, not URLs. All-day end is exclusive; timed values require explicit ISO offsets and an IANA timeZone. Results accept labelled HTTP(S) links.',
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], required: true },
      id: { type: 'string' }, expectedRevision: { type: 'integer' },
      fields: { type: 'object', additionalProperties: false, properties: {
        title: { type: 'string' }, description: { type: 'string' }, kind: { type: 'string', enum: ['personal', 'bot'] }, ownerId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        status: { type: 'string', enum: TASK_STATUSES }, start: { oneOf: [{ type: 'string' }, { type: 'null' }] }, end: { oneOf: [{ type: 'string' }, { type: 'null' }] }, allDay: { type: 'boolean' }, timeZone: { type: 'string' }, due: { oneOf: [{ type: 'string' }, { type: 'null' }] }, waiting: { type: 'string' }, conversationId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string', required: true }, url: { type: 'string', required: true } } } },
      } },
    }, output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return 'Only team Bots can use the task workbench.'
      // Private Bots may maintain their own tasks, but cannot publish to the shared board.
      const guard = task => privateOwner(task).every(id => id === self) && (!rt.botOf(self).private || task.ownerId === self)
      try { return JSON.stringify(await tasks(args.action, args, guard)) } catch (error) { return JSON.stringify({ error: error.message, code: error.code ?? 'bot/error' }) }
    },
  }))
}
