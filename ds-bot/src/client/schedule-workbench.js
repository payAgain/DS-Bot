import { createElement as h, useEffect, useRef, useState } from 'react'
import { language, t, hostText } from './i18n.js'
import { SCHEDULE_LABELS } from '../shared/scheduled-tasks.js'

export const SCHEDULE_COVERAGE = 'Scheduled tasks show only their next future delivery, not every recurrence or a booked duration.'
const at = (instant, zone) => new Intl.DateTimeFormat(language(), { timeZone: zone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant))
export function nextScheduleText(task, zone) {
  return task.start ? `${t('Next delivery')}: ${at(task.start, zone)}` : t(SCHEDULE_LABELS[task.status] ?? 'Unknown schedule state')
}
export function deliveryText(entry, zone) {
  if (entry.executionActive === true) return t('Delivered; queued or running')
  return Number.isFinite(Date.parse(entry.lastDelivery?.deliveredAt)) ? `${t('Delivered to the conversation')}: ${at(entry.lastDelivery.deliveredAt, zone)}` : t('No saved delivery receipt')
}
const button = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, t(label))
export function ScheduleDetail({ task, roster, actions, request, manageable, onChanged, onClose, onEditing }) {
  const entry = task.schedule
  const [draft, setDraft] = useState(null)
  const [confirmation, setConfirmation] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sending = useRef(false)
  const allowed = manageable && !roster.readOnly
  useEffect(() => () => onEditing(false), [])
  const run = async (action, expectedUpdatedAt, fields) => {
    if (!allowed || sending.current) return
    sending.current = true; setBusy(true); setError('')
    try {
      const result = await request('workbench-schedule-edit', { id: entry.id, action, expectedUpdatedAt, ...(fields ? { fields } : {}) })
      onChanged(result); setDraft(null); setConfirmation(undefined); onEditing(false)
      if (action === 'delete') onClose()
    } catch (failure) { setError(hostText(failure.message)) }
    finally { sending.current = false; setBusy(false) }
  }
  const edit = () => { setDraft({ title: entry.title, prompt: entry.prompt, rrule: entry.rrule, expectedUpdatedAt: entry.updatedAt ?? null, base: { title: entry.title, prompt: entry.prompt, rrule: entry.rrule } }); onEditing(true); setError('') }
  const save = event => {
    event.preventDefault()
    const fields = Object.fromEntries(['title', 'prompt', 'rrule'].filter(key => draft[key] !== draft.base[key]).map(key => [key, draft[key]]))
    if (!Object.keys(fields).length) { setDraft(null); onEditing(false); return }
    void run('update', draft.expectedUpdatedAt, fields)
  }
  const owner = [...roster.bots, ...roster.rooms].find(item => item.id === task.ownerId)
  return h('div', { className: 'bt-wb-detail bt-wb-schedule-detail' },
    h('div', { className: 'bt-wb-detail-top' }, h('strong', null, t('Scheduled task')), button('Close details', onClose)),
    h('h2', null, task.title), h('span', { className: 'bt-wb-status', 'data-status': task.status }, t(SCHEDULE_LABELS[task.status])),
    h('dl', null, h('dt', null, t('Owner')), h('dd', null, owner?.name ?? t('Original conversation')),
      h('dt', null, t('Next delivery')), h('dd', null, nextScheduleText(task, task.timeZone)),
      h('dt', null, t('Time zone')), h('dd', null, task.timeZone),
      h('dt', null, t('Latest delivery')), h('dd', null, deliveryText(entry, task.timeZone))),
    h('p', { className: 'bt-wb-note' }, t('A delivery receipt does not mean the task finished.')),
    h('p', { className: 'bt-wb-note' }, t(SCHEDULE_COVERAGE)),
    draft ? h('form', { onSubmit: save, className: 'bt-wb-schedule-form' },
      ...['title', 'prompt', ...(entry.kind === 'rrule' ? ['rrule'] : [])].map(key => h('label', { className: 'bt-wb-field', key }, h('span', null, t({ title: 'Title', prompt: 'Scheduled instruction', rrule: 'Recurrence rule' }[key])),
        key === 'title' ? h('input', { value: draft[key], required: true, maxLength: 120, onChange: event => setDraft(old => ({ ...old, [key]: event.target.value })) })
          : h('textarea', { value: draft[key], required: true, rows: key === 'rrule' ? 3 : 6, onChange: event => setDraft(old => ({ ...old, [key]: event.target.value })) }))),
      entry.kind === 'rrule' ? h('p', { className: 'bt-wb-note' }, t('Advanced rule: keep one DTSTART and one RRULE line. The Host validates the change.')) : null,
      h('div', { className: 'bt-wb-editor-actions' }, h('button', { type: 'submit', className: 'bt-wb-primary', disabled: busy }, t('Save schedule')), button('Cancel', () => { setDraft(null); onEditing(false) }, { disabled: busy })))
      : h('div', null, h('h3', null, t('Scheduled instruction')), h('p', { className: 'bt-wb-description' }, entry.prompt),
        entry.rrule ? h('details', null, h('summary', null, t('Recurrence rule')), h('pre', { className: 'bt-wb-rule' }, entry.rrule)) : null,
        h('div', { className: 'bt-wb-editor-actions' }, button('Edit schedule', edit, { disabled: !allowed || busy }),
          entry.status === 'active' ? button('Pause schedule', () => { void run('pause', entry.updatedAt ?? null) }, { disabled: !allowed || busy }) : null,
          entry.status === 'paused' ? button('Resume schedule', () => { void run('resume', entry.updatedAt ?? null) }, { disabled: !allowed || busy }) : null,
          button('Delete schedule', () => setConfirmation(entry.updatedAt ?? null), { disabled: !allowed || busy, className: 'bt-wb-danger' }))),
    // Capture the revision at the destructive decision, including legacy null revisions.
    confirmation !== undefined ? h('div', { className: 'bt-wb-delete', role: 'alert' }, h('p', null, t('Delete this scheduled task and its delivery history?')), button('Cancel', () => setConfirmation(undefined)), button('Confirm delete', () => { void run('delete', confirmation) }, { disabled: busy, className: 'bt-wb-danger' })) : null,
    error ? h('p', { className: 'bt-wb-error', role: 'alert' }, error) : null,
    !allowed ? h('p', { className: 'bt-wb-note' }, t('Schedule controls are unavailable in this view.')) : null,
    h('div', { className: 'bt-wb-editor-actions' },
      button('Open original schedule manager', () => { if (draft) return; actions.closeTasks(); actions.openSettings('schedules', entry.botId ? `bot:${entry.botId}` : entry.roomId ? `room:${entry.roomId}` : null) }, { disabled: Boolean(draft) }),
      task.conversationId ? button('Open original conversation', () => { if (draft) return; actions.closeTasks(); actions.openSession(task.conversationId) }, { disabled: Boolean(draft) }) : null))
}
export const SCHEDULE_WORKBENCH_CSS = `
.bt-wb-scheduled-section{margin:24px 0}.bt-wb-scheduled-section>h2{font-size:15px;margin:0 0 8px}.bt-wb-scheduled-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}.bt-wb-scheduled-grid .bt-wb-card{height:100%}.bt-wb-schedule-badge{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--bt-accent);font-size:12px}.bt-wb-rule{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;background:var(--bt-hover);padding:12px;border-radius:8px}.bt-wb-schedule-detail summary{cursor:pointer;color:var(--bt-ink-2)}.bt-wb-delivery{font-size:12px;color:var(--bt-ink-2)}.bt-wb-board[data-with-schedules]{min-height:0;margin-bottom:24px}.bt-wb-coverage{padding:10px 12px;border:1px solid var(--bt-line);border-radius:8px;margin:0 0 16px;font-size:12px;color:var(--bt-ink-2)}.bt-wb-day-event[data-scheduled]{border-left:2px solid var(--bt-accent)}
`
