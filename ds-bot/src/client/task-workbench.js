import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { t, language, hostText } from './i18n.js'
import { scheduledRows, SCHEDULE_LABELS } from '../shared/scheduled-tasks.js'
import { ScheduleDetail, nextScheduleText, deliveryText, SCHEDULE_COVERAGE, SCHEDULE_WORKBENCH_CSS } from './schedule-workbench.js'
import { addDays, dayInZone, instantFromWall, taskOnDay, TASK_STATUSES, wallTime } from '../shared/task-time.js'

const LABELS = { todo: 'To plan', doing: 'In progress', waiting: 'Waiting', review: 'To review', done: 'Completed', cancelled: 'Cancelled' }
const zoneHere = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const emptyTask = zone => ({ title: '', description: '', kind: 'personal', ownerId: null, status: 'todo', start: null, end: null, allDay: false, timeZone: zone, due: null, waiting: '', conversationId: null, results: [] })
export function scheduleLabel(task, zone) {
  if (task.source === 'schedule') return nextScheduleText(task, zone)
  if (!task.start) return t('Unscheduled')
  if (task.allDay) return `${task.start} → ${addDays(task.end, -1)} · ${t('All day')}`
  const format = instant => new Intl.DateTimeFormat(language(), { timeZone: zone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant))
  return `${format(task.start)} → ${format(task.end)}`
}
const button = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, t(label))
const field = (label, child) => h('label', { className: 'bt-wb-field' }, h('span', null, t(label)), child)
const input = (value, onChange, props = {}) => h('input', { value: value ?? '', onChange: event => onChange(event.target.value), ...props })
const choice = (value, onChange, entries, props = {}) => h('select', { value: value ?? '', onChange: event => onChange(event.target.value), ...props }, entries.map(([key, label]) => h('option', { key, value: key }, label)))

function TaskEditor({ task, roster, onSave, onDelete, onCancel, busy, error, zone }) {
  const [draft, setDraft] = useState(() => ({ ...emptyTask(zone), ...task }))
  const [start, setStart] = useState(() => task?.start ? task.allDay ? task.start : wallTime(task.start, task.timeZone) : '')
  const [end, setEnd] = useState(() => task?.end ? task.allDay ? addDays(task.end, -1) : wallTime(task.end, task.timeZone) : '')
  const [localError, setLocalError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [resultLabel, setResultLabel] = useState('')
  const [resultUrl, setResultUrl] = useState('')
  const formRef = useRef(null)
  useEffect(() => { formRef.current?.querySelector('input')?.focus() }, [])
  const set = (key, value) => setDraft(old => ({ ...old, [key]: value }))
  const save = async event => {
    event.preventDefault()
    setLocalError('')
    try {
      const fields = { ...draft }
      for (const key of ['id', 'revision', 'createdAt', 'updatedAt']) delete fields[key]
      // Preserve exact instants (including repeated DST hours) when untouched.
      const original = task?.start && !task.allDay && !draft.allDay && task.timeZone === draft.timeZone
      fields.start = start ? draft.allDay ? start : original && wallTime(task.start, draft.timeZone) === start ? task.start : instantFromWall(start, draft.timeZone) : null
      fields.end = end ? draft.allDay ? addDays(end, 1) : original && wallTime(task.end, draft.timeZone) === end ? task.end : instantFromWall(end, draft.timeZone) : null
      if (resultLabel || resultUrl) throw new Error(t('Add or clear the result link before saving.'))
      await onSave(fields)
    } catch (failure) { setLocalError(hostText(failure.message)) }
  }
  const changeAllDay = checked => {
    set('allDay', checked)
    setStart(value => checked ? value.slice(0, 10) : value ? `${value}T09:00` : '')
    setEnd(value => checked ? value.slice(0, 10) : value ? `${value}T10:00` : '')
  }
  return h('form', { className: 'bt-wb-editor', onSubmit: save, ref: formRef },
    h('div', { className: 'bt-wb-detail-top' }, h('strong', null, t(task?.id ? 'Edit task' : 'New task')), button('Cancel', onCancel)),
    field('Title', input(draft.title, value => set('title', value), { required: true, maxLength: 200 })),
    field('Description', h('textarea', { value: draft.description, rows: 4, maxLength: 12000, onChange: event => set('description', event.target.value) })),
    h('div', { className: 'bt-wb-fields' },
      field('Task type', choice(draft.kind, value => { set('kind', value); if (value === 'bot') set('ownerId', roster.bots[0]?.id ?? null) }, [['personal', t('Personal')], ['bot', t('Bot work')]])),
      field('Status', choice(draft.status, value => set('status', value), TASK_STATUSES.map(status => [status, t(LABELS[status])])))),
    draft.kind === 'bot' ? field('Owner', choice(draft.ownerId, value => set('ownerId', value), [['', t('Choose a Bot')], ...roster.bots.map(bot => [bot.id, bot.name])])) : null,
    field('Waiting reason', input(draft.waiting, value => set('waiting', value), { maxLength: 1000 })),
    h('div', { className: 'bt-wb-section-head' }, h('strong', null, t('Planned time')), button('Clear time', () => { setStart(''); setEnd('') })),
    field('Time zone', input(draft.timeZone, value => set('timeZone', value), { required: true, placeholder: 'Asia/Shanghai', list: 'bt-wb-zones' })),
    h('datalist', { id: 'bt-wb-zones' }, ['Asia/Shanghai', 'Asia/Tokyo', 'UTC', 'America/New_York', 'Europe/London'].map(value => h('option', { key: value, value }))),
    h('label', { className: 'bt-wb-check' }, h('input', { type: 'checkbox', checked: draft.allDay, onChange: event => changeAllDay(event.target.checked) }), t('All day')),
    h('div', { className: 'bt-wb-fields' }, field('Start', input(start, setStart, { type: draft.allDay ? 'date' : 'datetime-local' })), field(draft.allDay ? 'Last day (inclusive)' : 'End', input(end, setEnd, { type: draft.allDay ? 'date' : 'datetime-local' }))),
    h('p', { className: 'bt-wb-note' }, t('Planned time reserves an interval. A deadline does not appear as booked time.')),
    field('Deadline (optional)', input(draft.due, value => set('due', value || null), { type: 'date' })),
    field('Original conversation', choice(draft.conversationId, value => set('conversationId', value || null), [['', t('No conversation')], ...roster.bots.map(bot => [bot.id, bot.name]), ...roster.rooms.map(room => [room.id, room.name])])),
    h('strong', null, t('Results')),
    draft.results.map((item, index) => h('div', { className: 'bt-wb-result-edit', key: index }, h('span', null, item.label), button('Remove', () => set('results', draft.results.filter((_, i) => i !== index))))),
    field('Result label', input(resultLabel, setResultLabel, { maxLength: 200 })),
    field('Result URL', input(resultUrl, setResultUrl, { type: 'url', maxLength: 2000, placeholder: 'https://' })),
    button('Add result link', () => {
      if (!resultLabel.trim() || !/^https?:\/\//i.test(resultUrl)) { setLocalError(t('Enter a label and an HTTP(S) URL.')); return }
      set('results', [...draft.results, { label: resultLabel.trim(), url: resultUrl }]); setResultLabel(''); setResultUrl(''); setLocalError('')
    }, { disabled: draft.results.length >= 20 }),
    error || localError ? h('p', { className: 'bt-wb-error', role: 'alert' }, localError || error) : null,
    h('div', { className: 'bt-wb-editor-actions' }, h('button', { type: 'submit', className: 'bt-wb-primary', disabled: busy }, t(busy ? 'Saving…' : 'Save task')), task?.id ? button('Delete task', () => setDeleting(true), { className: 'bt-wb-danger', disabled: busy }) : null),
    deleting ? h('div', { className: 'bt-wb-delete', role: 'alert' }, h('p', null, t('Delete this task? This cannot be undone.')), button('Cancel', () => setDeleting(false)), button('Confirm delete', onDelete, { disabled: busy, className: 'bt-wb-danger' })) : null)
}

function TaskDetail({ task, roster, onEdit, onClose, actions }) {
  const owner = roster.bots.find(bot => bot.id === task.ownerId)
  const conversation = [...roster.bots, ...roster.rooms].find(item => item.id === task.conversationId)
  return h('div', { className: 'bt-wb-detail' },
    h('div', { className: 'bt-wb-detail-top' }, h('span', { className: 'bt-wb-id' }, task.id.slice(-8)), button('Close details', onClose, { 'aria-label': t('Close details') })),
    h('h2', null, task.title), h('span', { className: 'bt-wb-status', 'data-status': task.status }, t(LABELS[task.status])),
    h('p', { className: 'bt-wb-description' }, task.description || t('No description')),
    h('dl', null, h('dt', null, t('Owner')), h('dd', null, owner?.name ?? (task.kind === 'personal' ? t('Me') : t('Former Bot'))),
      h('dt', null, t('Planned time')), h('dd', null, scheduleLabel(task, task.timeZone)),
      h('dt', null, t('Time zone')), h('dd', null, task.timeZone),
      task.due ? h('dt', null, t('Deadline (optional)')) : null, task.due ? h('dd', null, task.due) : null),
    task.waiting ? h('div', { className: 'bt-wb-wait' }, t('Waiting reason'), h('p', null, task.waiting)) : null,
    h('h3', null, t('Linked content')),
    conversation ? button('Open original conversation', () => { onClose(); actions.closeTasks(); actions.openSession(conversation.id) }, { className: 'bt-wb-linked' }) : h('p', { className: 'bt-wb-note' }, t('No conversation')),
    task.results.map((result, index) => h('a', { className: 'bt-wb-linked', key: index, href: result.url, target: '_blank', rel: 'noopener noreferrer' }, result.label, ' ↗')),
    h('p', { className: 'bt-wb-note' }, t('Task status is explicit. A Bot reply does not mark it complete.')),
    h('div', { className: 'bt-wb-editor-actions' }, button('Edit task', onEdit, { className: 'bt-wb-primary' })))
}

export function TaskWorkbench({ roster, actions, request = call, initialZone, initialToday }) {
  const [zone, setZone] = useState(initialZone ?? zoneHere)
  const today = initialToday ?? dayInZone(Date.now(), zone)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [scheduleView, setScheduleView] = useState(null)
  const [scheduleError, setScheduleError] = useState('')
  const [scheduleEditing, setScheduleEditing] = useState(false)
  const [scheduleDraftTask, setScheduleDraftTask] = useState(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState('board')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [owner, setOwner] = useState('all')
  const [archived, setArchived] = useState(false)
  const [unscheduled, setUnscheduled] = useState(false)
  const [month, setMonth] = useState(today.slice(0, 7))
  const [day, setDay] = useState(today)
  const [selected, setSelected] = useState(null)
  const [editing, setEditing] = useState(false)
  const [createDay, setCreateDay] = useState(null)
  const [createStatus, setCreateStatus] = useState('todo')
  const root = useRef(null)
  const agenda = useRef(null)
  const selectDay = date => { setDay(date); requestAnimationFrame(() => agenda.current?.scrollIntoView({ block: 'nearest' })) }
  const dataRef = useRef(null)
  const inFlight = useRef(false)
  const scheduleGeneration = useRef(0)
  useEffect(() => {
    let ignore = false
    let order = 0
    let applied = 0
    const refresh = async () => {
      const n = ++order
      try {
        const result = await request('tasks-list')
        if (!ignore && n >= applied && (dataRef.current?.revision ?? -1) <= result.revision) { applied = n; dataRef.current = result; setData(result) }
      } catch (failure) { if (!ignore) setError(failure.message) }
    }
    void refresh()
    const timer = setInterval(refresh, 5000)
    return () => { ignore = true; clearInterval(timer) }
  }, [request])
  useEffect(() => {
    const before = document.activeElement
    root.current?.focus()
    return () => before?.focus?.()
  }, [])
  useEffect(() => {
    let stopped = false
    let timer
    const refresh = async () => {
      const generation = scheduleGeneration.current
      try { const result = await request('workbench-schedules'); if (!stopped && generation === scheduleGeneration.current) { setScheduleView(result); setScheduleError('') } }
      catch (failure) { if (!stopped && generation === scheduleGeneration.current) setScheduleError(failure.message) }
      finally { if (!stopped) timer = setTimeout(refresh, 15000) }
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [request])
  const close = () => {
    if (editing || scheduleEditing) { setError(t('Save or cancel your task edit before closing.')); return }
    actions.closeTasks()
  }
  const choose = task => {
    if (editing || scheduleEditing) { setError(t('Save or cancel your task edit first.')); return }
    setSelected(task.id); setError('')
  }
  const create = (plannedDay, status = 'todo') => { if (editing || scheduleEditing) return; setSelected(null); setCreateDay(plannedDay); setCreateStatus(status); setEditing(true); setError('') }
  const mutate = async (action, fields) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    const task = data.tasks.find(item => item.id === selected)
    try {
      const result = await request(`tasks-${action}`, { id: selected, expectedRevision: task?.revision, ...(fields ? { fields } : {}) })
      // Always fetch after write; never combine a newer poll with an older row.
      const fresh = await request('tasks-list')
      if ((dataRef.current?.revision ?? -1) <= fresh.revision) { dataRef.current = fresh; setData(fresh) }
      setSelected(result.task?.id ?? null); setEditing(false)
    } catch (failure) { setError(failure.message); throw failure }
    finally { inFlight.current = false; setBusy(false) }
  }
  // The edit's initial revision is captured by the editor key, not updated by polls.
  const [editRevision, setEditRevision] = useState(null)
  const edit = task => { setEditRevision(task.revision); setEditing(true); setError('') }
  const save = fields => {
    const current = data.tasks.find(item => item.id === selected)
    if (selected && (!current || current.revision !== editRevision)) { setError(t('This task changed elsewhere. Cancel and reopen the editor.')); return Promise.reject(new Error(t('This task changed elsewhere. Cancel and reopen the editor.'))) }
    return mutate(current ? 'update' : 'create', fields)
  }
  const projected = scheduledRows(scheduleView?.tasks ?? [])
  const tasks = (kind === 'scheduled' ? [] : data?.tasks ?? []).filter(task => (archived ? ['done', 'cancelled'].includes(task.status) : !['done', 'cancelled'].includes(task.status)) && (['all', 'ordinary'].includes(kind) || task.kind === kind) && (owner === 'all' || task.ownerId === owner || (owner === 'me' && !task.ownerId)) && (!unscheduled || !task.start) && (!query || `${task.title} ${task.description} ${task.waiting} ${roster.bots.find(bot => bot.id === task.ownerId)?.name ?? ''} ${task.results.map(item => item.label).join(' ')}`.toLowerCase().includes(query.toLowerCase())))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const schedules = (['all', 'scheduled'].includes(kind) ? projected : []).filter(task => (owner === 'all' || task.ownerId === owner) && !unscheduled && (!query || `${task.title} ${roster.bots.find(bot => bot.id === task.ownerId)?.name ?? ''}`.toLowerCase().includes(query.toLowerCase())))
  const calendarTasks = [...tasks, ...schedules]
  const current = [...(data?.tasks ?? []), ...projected].find(task => task.id === selected) ?? (scheduleEditing ? scheduleDraftTask : undefined)
  const showOrdinary = kind !== 'scheduled' && (tasks.length > 0 || schedules.length === 0 || kind !== 'all')
  const showScheduled = ['all', 'scheduled'].includes(kind)
  const statuses = archived ? ['done', 'cancelled'] : TASK_STATUSES.slice(0, 4)
  const card = task => h('button', { type: 'button', key: task.id, className: 'bt-wb-card', 'data-selected': task.id === selected || undefined, onClick: () => choose(task) },
    h('span', { className: 'bt-wb-kind' }, task.source === 'schedule' ? h('span', { className: 'bt-wb-schedule-badge' }, t('Scheduled task'), h('span', null, t(SCHEDULE_LABELS[task.status]))) : t(task.kind === 'personal' ? 'Personal' : 'Bot work')),
    h('strong', null, task.title), task.waiting || task.description ? h('span', { className: task.waiting ? 'bt-wb-wait-text' : 'bt-wb-excerpt' }, task.waiting || task.description) : null,
    h('span', { className: 'bt-wb-owner' }, [...roster.bots, ...roster.rooms].find(bot => bot.id === task.ownerId)?.name ?? (task.kind === 'personal' ? t('Me') : t('Former Bot'))),
    h('span', { className: 'bt-wb-card-time' }, scheduleLabel(task, zone)), task.source === 'schedule' ? h('span', { className: 'bt-wb-delivery' }, deliveryText(task.schedule, zone)) : null, task.results.length ? h('span', { className: 'bt-wb-result-count' }, t('{count} results', { count: task.results.length })) : null)
  const shiftMonth = amount => {
    const date = new Date(`${month}-15T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + amount); setMonth(date.toISOString().slice(0, 7))
  }
  const first = `${month}-01`
  const gridStart = addDays(first, (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7 * -1)
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index))
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key === 'Tab') {
      const nodes = [...root.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')].filter(node => node.getClientRects().length)
      if (!nodes.length) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === root.current)) { event.preventDefault(); nodes.at(-1).focus() }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus() }
    }
  }
  return h('section', { className: 'bt-wb-workbench', role: 'dialog', 'aria-modal': true, 'aria-label': t('Task workbench'), tabIndex: -1, ref: root, onKeyDown: onKey },
    h('header', { className: 'bt-wb-header' }, h('div', null, h('h1', null, t('Task workbench')), h('p', null, t('Plan your time and keep Bot work in view.'))), button('Back to chats', close)),
    h('div', { className: 'bt-wb-toolbar' }, input(query, setQuery, { type: 'search', placeholder: t('Search tasks, owners or results'), 'aria-label': t('Search tasks, owners or results') }),
      choice(owner, setOwner, [['all', t('All owners')], ['me', t('Me')], ...roster.bots.map(bot => [bot.id, bot.name])], { 'aria-label': t('Owner') }),
      choice(kind, setKind, [['all', t('All tasks')], ['ordinary', t('Ordinary tasks')], ['scheduled', t('Scheduled tasks')], ['personal', t('Personal')], ['bot', t('Bot work')]], { 'aria-label': t('Task type') }),
      h('div', { className: 'bt-wb-switch' }, button('Board', () => setMode('board'), { 'aria-pressed': mode === 'board' }), button('Calendar', () => setMode('calendar'), { 'aria-pressed': mode === 'calendar' })),
      button('New task', () => create(null), { className: 'bt-wb-primary', disabled: editing || scheduleEditing || !data || Boolean(roster.readOnly) })),
    h('div', { className: 'bt-wb-subbar' }, h('span', null, t('{count} tasks', { count: tasks.length + schedules.length })),
      h('label', null, h('input', { type: 'checkbox', checked: archived, onChange: event => setArchived(event.target.checked) }), t('Completed / cancelled')),
      h('label', null, h('input', { type: 'checkbox', checked: unscheduled, onChange: event => setUnscheduled(event.target.checked) }), t('Unscheduled only')),
      h('span', { className: 'bt-wb-note' }, `${t('Calendar time zone')}: ${zone}`)),
    scheduleError ? h('div', { className: 'bt-wb-error', role: 'alert' }, t('Could not refresh scheduled tasks.'), ' ', scheduleError) : null,
    error && !editing ? h('div', { className: 'bt-wb-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-wb-body', 'data-details': Boolean(current || editing) || undefined },
      h('main', { className: 'bt-wb-main' }, !data ? h('p', null, t('Loading…')) : mode === 'board'
        ? h('div', null, showOrdinary ? h('div', { className: 'bt-wb-board', 'data-with-schedules': showScheduled || undefined }, statuses.map(status => h('section', { key: status, className: 'bt-wb-column' }, h('h2', null, h('i', { 'data-status': status }), t(LABELS[status]), h('span', null, tasks.filter(task => task.status === status).length)), h('div', { className: 'bt-wb-column-body' }, tasks.filter(task => task.status === status).map(card), button('Add task', () => create(null, status), { disabled: editing || Boolean(roster.readOnly) })))), tasks.length === 0 ? h('p', { className: 'bt-wb-empty' }, t('No tasks yet. Create your first task.')) : null) : null,
          showScheduled ? h('section', { className: 'bt-wb-scheduled-section' }, h('h2', null, t('Scheduled tasks')), h('p', { className: 'bt-wb-note' }, t(SCHEDULE_COVERAGE)),
            scheduleView === null ? h('p', null, t('Loading…')) : !scheduleView.available ? h('p', null, t('Scheduled tasks are unavailable in this Host.')) : h('div', { className: 'bt-wb-scheduled-grid' }, schedules.map(card)),
            scheduleView?.available && schedules.length === 0 ? h('p', { className: 'bt-wb-note' }, t('No matching scheduled tasks.')) : null) : null)
        : h('div', { className: 'bt-wb-calendar' },
          showScheduled ? h('p', { className: 'bt-wb-coverage' }, t(SCHEDULE_COVERAGE)) : null,
          h('div', { className: 'bt-wb-calendar-head' }, button('Previous month', () => shiftMonth(-1)), h('strong', null, new Intl.DateTimeFormat(language(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T12:00:00Z`))), button('Next month', () => shiftMonth(1)), button('Today', () => { setMonth(today.slice(0, 7)); setDay(today) }),
            choice(zone, value => setZone(value), [...new Set([zone, zoneHere(), 'Asia/Shanghai', 'Asia/Tokyo', 'UTC', 'America/New_York', 'Europe/London'])].map(value => [value, value]), { 'aria-label': t('Calendar time zone') })),
          h('div', { className: 'bt-wb-weekdays' }, Array.from({ length: 7 }, (_, index) => h('span', { key: index }, new Intl.DateTimeFormat(language(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(`2026-11-${String(9 + index).padStart(2, '0')}T12:00:00Z`))))),
          h('div', { className: 'bt-wb-month', role: 'group', 'aria-label': t('Calendar') }, days.map(date => {
            const daily = calendarTasks.filter(task => taskOnDay(task, date, zone)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
            return h('div', { key: date, className: 'bt-wb-day', 'data-outside': date.slice(0, 7) !== month || undefined, 'data-today': date === today || undefined, 'data-selected': date === day || undefined },
              button(date.slice(-2).replace(/^0/, ''), () => selectDay(date), { 'aria-label': date, 'aria-pressed': date === day }),
              daily.slice(0, 3).map(task => h('button', { type: 'button', className: 'bt-wb-day-event', 'data-scheduled': task.source === 'schedule' || undefined, key: task.id, onClick: () => { setDay(date); choose(task) }, title: `${task.title} · ${scheduleLabel(task, zone)}` }, task.allDay ? '' : `${wallTime(task.start, zone).slice(11)} `, task.title)),
              daily.length > 3 ? button(`+${daily.length - 3}`, () => selectDay(date), { 'aria-label': `${date} +${daily.length - 3}` }) : null)
          })),
          h('section', { className: 'bt-wb-agenda', ref: agenda }, h('div', { className: 'bt-wb-section-head' }, h('h2', null, day), button('Schedule a task', () => create(day), { disabled: editing || Boolean(roster.readOnly) })),
            h('p', { className: 'bt-wb-note' }, t('Planned intervals only · deadlines are shown in task details.')),
            calendarTasks.filter(task => taskOnDay(task, day, zone)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start)).map(card), calendarTasks.some(task => taskOnDay(task, day, zone)) ? null : h('p', { className: 'bt-wb-note' }, t('Nothing planned for this day.'))),
          h('section', { className: 'bt-wb-unscheduled' }, h('h2', null, t('Unscheduled')), tasks.filter(task => !task.start).map(card)))),
      current || editing ? h('aside', { className: 'bt-wb-inspector', 'aria-label': t('Task details') }, current?.source === 'schedule' ? h(ScheduleDetail, { key: current.id, task: current, roster, actions, request, manageable: scheduleView?.manageable === true, onChanged: next => { scheduleGeneration.current += 1; setScheduleView(next); setScheduleError(''); setError('') }, onEditing: value => { setScheduleEditing(value); setScheduleDraftTask(value ? current : null) }, onClose: () => { if (scheduleEditing) { setError(t('Save or cancel your task edit first.')); return } setSelected(null) } }) : editing
        ? h(TaskEditor, { key: `${selected ?? 'new'}-${createDay ?? ''}`, task: current ?? { ...emptyTask(zone), status: createStatus, ...(createDay ? { start: createDay, end: addDays(createDay, 1), allDay: true } : {}) }, roster, zone, busy, error,
          onSave: save, onCancel: () => { setEditing(false); setError('') }, onDelete: () => { if (current?.revision !== editRevision) { setError(t('This task changed elsewhere. Cancel and reopen the editor.')); return } void mutate('delete').catch(() => {}) } })
        : h(TaskDetail, { task: current, roster, zone, actions, onClose: () => setSelected(null), onEdit: () => edit(current) })) : null))
}

export const TASK_CSS = SCHEDULE_WORKBENCH_CSS + `
.bt-wb-workbench{position:fixed;inset:0;z-index:1100;background:var(--bt-main);color:var(--bt-ink);font:13px/1.5 var(--bt-font);display:flex;flex-direction:column;padding:28px;box-sizing:border-box;outline:none;overflow:hidden}
.bt-wb-workbench *{box-sizing:border-box}.bt-wb-workbench button,.bt-wb-workbench input,.bt-wb-workbench select,.bt-wb-workbench textarea{font:inherit;color:inherit;border:1px solid var(--bt-line);background:var(--bt-card);border-radius:8px;padding:8px 12px;min-width:0}.bt-wb-workbench button{cursor:pointer}.bt-wb-workbench button:hover{background:var(--bt-hover)}.bt-wb-workbench button:disabled{cursor:default;opacity:.5}.bt-wb-workbench :focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}.bt-wb-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}.bt-wb-header h1{font-size:22px;line-height:1.4;margin:0 0 6px;font-weight:600}.bt-wb-header p{color:var(--bt-ink-2);margin:0}.bt-wb-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.bt-wb-toolbar input[type=search]{flex:1;min-width:180px}.bt-wb-toolbar select{max-width:180px}.bt-wb-switch{display:flex;padding:3px;background:var(--bt-hover);border-radius:10px}.bt-wb-switch button{border:0;background:none}.bt-wb-switch button[aria-pressed=true]{color:var(--bt-accent);background:var(--bt-card);box-shadow:0 1px 4px var(--bt-line)}.bt-wb-workbench .bt-wb-primary{background:var(--bt-accent);color:var(--bt-accent-ink);border-color:var(--bt-accent)}.bt-wb-workbench .bt-wb-primary:hover{filter:brightness(.96);background:var(--bt-accent)}.bt-wb-subbar{display:flex;flex-wrap:wrap;gap:16px;align-items:center;color:var(--bt-ink-2);padding:18px 0}.bt-wb-subbar label{display:flex;align-items:center;gap:6px}.bt-wb-note{font-size:12px;color:var(--bt-ink-2);line-height:1.6}.bt-wb-body{display:flex;flex:1;min-height:0;gap:24px;position:relative}.bt-wb-main{flex:1;min-width:0;overflow:auto}.bt-wb-board{display:grid;grid-template-columns:repeat(4,minmax(200px,1fr));gap:16px;min-height:100%;position:relative}.bt-wb-column h2{font-size:13px;display:flex;gap:8px;align-items:center;margin:0 0 14px;font-weight:600}.bt-wb-column h2>span{margin-left:auto;font-size:12px;color:var(--bt-ink-3)}.bt-wb-column h2 i{width:7px;height:7px;border-radius:50%;background:var(--bt-ink-3)}.bt-wb-column h2 i[data-status=doing]{background:var(--bt-accent)}.bt-wb-column h2 i[data-status=waiting]{background:var(--bt-star)}.bt-wb-column h2 i[data-status=review]{background:var(--bt-green)}.bt-wb-column-body{background:var(--bt-hover);border-radius:12px;min-height:320px;padding:10px;display:flex;flex-direction:column;gap:12px}.bt-wb-workbench .bt-wb-card{width:100%;text-align:left;background:var(--bt-card);padding:16px;border-radius:12px;display:flex;flex-direction:column;gap:12px;box-shadow:0 2px 6px color-mix(in srgb,var(--bt-ink) 3%,transparent);overflow:hidden}.bt-wb-workbench .bt-wb-card[data-selected]{border-color:var(--bt-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--bt-accent) 30%,transparent)}.bt-wb-card strong{font-size:15px;font-weight:600;overflow-wrap:anywhere}.bt-wb-kind{color:var(--bt-ink-3);font-size:12px}.bt-wb-excerpt,.bt-wb-wait-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--bt-ink-2);overflow-wrap:anywhere}.bt-wb-wait-text{color:var(--bt-star)}.bt-wb-owner{font-weight:500}.bt-wb-card-time{font-size:12px;color:var(--bt-ink-2);border-top:1px solid var(--bt-line);padding-top:10px}.bt-wb-result-count{font-size:12px;color:var(--bt-accent)}.bt-wb-inspector{flex:0 0 340px;max-width:40%;border:1px solid var(--bt-line);border-radius:16px;background:var(--bt-card);overflow:auto;padding:22px}.bt-wb-detail-top,.bt-wb-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.bt-wb-id{font-size:12px;color:var(--bt-accent)}.bt-wb-detail h2{font-size:22px;overflow-wrap:anywhere;margin:12px 0}.bt-wb-status{display:inline-block;background:var(--bt-tag-bg);color:var(--bt-tag-ink);border-radius:20px;padding:4px 10px;font-size:12px}.bt-wb-status[data-status=review]{color:var(--bt-green)}.bt-wb-description{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--bt-ink-2);line-height:1.8;margin:24px 0}.bt-wb-detail dl{display:grid;grid-template-columns:90px 1fr;gap:16px 12px;padding:24px 0;border-block:1px solid var(--bt-line)}.bt-wb-detail dt{color:var(--bt-ink-3)}.bt-wb-detail dd{margin:0;overflow-wrap:anywhere}.bt-wb-detail h3{font-size:13px;margin:24px 0 12px}.bt-wb-linked{display:block;width:100%;text-align:left;padding:12px;margin-bottom:10px;border:1px solid var(--bt-line);border-radius:8px;color:var(--bt-accent);text-decoration:none;overflow-wrap:anywhere}.bt-wb-field{display:flex;flex-direction:column;gap:6px;margin:14px 0}.bt-wb-field>span{font-size:12px;color:var(--bt-ink-2)}.bt-wb-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.bt-wb-field textarea{resize:vertical;min-height:80px}.bt-wb-check{display:flex;align-items:center;gap:8px}.bt-wb-editor-actions{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}.bt-wb-workbench .bt-wb-danger{color:var(--bt-danger)}.bt-wb-error,.bt-wb-delete{padding:10px 12px;border:1px solid var(--bt-danger);border-radius:8px;color:var(--bt-danger);margin:12px 0;white-space:pre-wrap}.bt-wb-result-edit{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0}.bt-wb-result-edit span{overflow-wrap:anywhere;min-width:0}.bt-wb-calendar-head{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}.bt-wb-calendar-head strong{flex:1;text-align:center;font-size:15px}.bt-wb-calendar-head select{max-width:180px}.bt-wb-weekdays,.bt-wb-month{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}.bt-wb-weekdays span{text-align:center;color:var(--bt-ink-3);padding:8px;font-size:12px}.bt-wb-month{border:1px solid var(--bt-line);border-radius:12px;overflow:hidden}.bt-wb-day{min-height:115px;padding:6px;border-right:1px solid var(--bt-line);border-bottom:1px solid var(--bt-line);overflow:hidden}.bt-wb-day[data-selected]{background:var(--bt-hover)}.bt-wb-day[data-outside]{opacity:.5}.bt-wb-day>button:first-child{padding:3px 7px;border:0;background:none}.bt-wb-day[data-today]>button:first-child{background:var(--bt-accent);color:var(--bt-accent-ink);border-radius:50%}.bt-wb-workbench .bt-wb-day-event{display:block;width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:color-mix(in srgb,var(--bt-accent) 9%,var(--bt-card));color:var(--bt-accent);font-size:11px;padding:3px 5px;margin-top:3px;border-radius:4px}.bt-wb-agenda,.bt-wb-unscheduled{margin-top:24px}.bt-wb-agenda h2,.bt-wb-unscheduled h2{font-size:15px}.bt-wb-agenda>.bt-wb-card,.bt-wb-unscheduled>.bt-wb-card{margin:10px 0}.bt-wb-empty{position:absolute;top:170px;left:20px;right:20px;text-align:center;color:var(--bt-ink-3);pointer-events:none}.bt-wb-entry{margin:6px 8px;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 12px;border:1px solid var(--bt-line);background:var(--bt-hover);color:var(--bt-ink);border-radius:10px;cursor:pointer;font:13px var(--bt-font)}.bt-wb-entry:hover{color:var(--bt-accent)}
@media(min-width:1600px){.bt-wb-inspector{flex-basis:400px}.bt-wb-workbench{padding:36px}}@media(max-width:1050px){.bt-wb-inspector{flex-basis:320px;max-width:45%}.bt-wb-board{grid-template-columns:repeat(4,210px)}}@media(max-width:700px){.bt-wb-workbench{padding:16px}.bt-wb-header{margin-bottom:16px}.bt-wb-header h1{font-size:17px}.bt-wb-header p{font-size:12px}.bt-wb-toolbar{gap:8px}.bt-wb-toolbar input[type=search]{flex-basis:100%}.bt-wb-toolbar select{max-width:none;flex:1 1 calc(50% - 4px)}.bt-wb-subbar{gap:8px;font-size:12px}.bt-wb-subbar>.bt-wb-note{width:100%}.bt-wb-body{gap:0}.bt-wb-inspector{position:absolute;inset:0;max-width:none;width:100%;z-index:1;padding:18px}.bt-wb-month .bt-wb-day{min-height:76px;padding:2px}.bt-wb-day-event{font-size:10px!important;padding:2px!important}.bt-wb-calendar-head{gap:4px}.bt-wb-calendar-head button{padding:6px}.bt-wb-weekdays span{padding:5px 0}.bt-wb-header>button{flex-shrink:0}}
`
