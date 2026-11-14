import { validZone } from './task-time.js'

export const SCHEDULE_LABELS = { scheduled: 'Enabled', overdue: 'Awaiting delivery', paused: 'Paused', finished: 'Finished', unknown: 'Unknown schedule state' }
export function scheduleZone(task) {
  const named = /^DTSTART;TZID=([^:;\r\n]+):/m.exec(task.rrule ?? '')?.[1]
  const zone = task.timeZone ?? named ?? 'UTC'
  return validZone(zone) ? zone : 'UTC'
}
export function scheduleState(task, now = Date.now()) {
  if (task.status === 'paused') return 'paused'
  if (task.status === 'ended' || task.status === 'inactive') return 'finished'
  if (task.status !== 'active') return 'unknown'
  const time = Date.parse(task.scheduledAt)
  return Number.isFinite(time) && time > now ? 'scheduled' : 'overdue'
}
// This is a detached display projection, never a new stored task or recurrence.
// The host's single committed future occurrence is a point, not a work interval.
export function scheduledRows(entries, now = Date.now()) {
  return entries.map(entry => {
    const state = scheduleState(entry, now)
    const instant = state === 'scheduled' ? new Date(entry.scheduledAt).toISOString() : null
    return {
      id: `schedule:${entry.id}`, source: 'schedule', kind: 'scheduled', title: entry.title,
      status: state, ownerId: entry.botId ?? entry.roomId ?? null, conversationId: entry.botId ?? entry.roomId ?? null,
      description: '', waiting: '', results: [], due: null, allDay: false, timeZone: scheduleZone(entry),
      start: instant, end: instant ? new Date(Date.parse(instant) + 1).toISOString() : null,
      updatedAt: Number.isFinite(Date.parse(entry.updatedAt)) ? Date.parse(entry.updatedAt) : 0,
      schedule: entry,
    }
  })
}
