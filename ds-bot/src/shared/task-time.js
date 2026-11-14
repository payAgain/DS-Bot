// Planned intervals are separate from deadlines. All-day end dates are exclusive.
export const TASK_STATUSES = ['todo', 'doing', 'waiting', 'review', 'done', 'cancelled']
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
export function validZone(zone) {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return typeof zone === 'string' && zone.length > 0 } catch { return false }
}
export function dayInZone(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant))
  const field = key => parts.find(part => part.type === key).value
  return `${field('year')}-${field('month')}-${field('day')}`
}
export function addDays(day, amount) {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}
export function taskOnDay(task, day, zone) {
  if (!task.start || !task.end) return false
  if (task.allDay) return task.start <= day && day < task.end
  return dayInZone(task.start, zone) <= day && day <= dayInZone(Date.parse(task.end) - 1, zone)
}
export function cleanSchedule(task) {
  if (!validZone(task.timeZone)) throw new Error('Choose a valid IANA time zone.')
  if (!task.start && !task.end) return { ...task, start: null, end: null }
  if (!task.start || !task.end) throw new Error('Planned start and end are both required.')
  if (task.allDay) {
    if (!validDate(task.start) || !validDate(task.end) || task.end <= task.start) throw new Error('All-day end must be after start (exclusive end date).')
  } else {
    const explicit = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) && validDate(value.slice(0, 10))
    if (!explicit(task.start) || !explicit(task.end) || Date.parse(task.end) <= Date.parse(task.start)) throw new Error('Use ISO timestamps with an offset; planned end must be after start.')
    task = { ...task, start: new Date(task.start).toISOString(), end: new Date(task.end).toISOString() }
  }
  return task
}
// Resolve a wall-clock input in a named zone. Gaps and repeated DST hours need an
// explicit offset via the API; never silently move the user's chosen local time.
export function wallTime(instant, zone) {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant))
  const f = type => p.find(part => part.type === type).value
  return `${f('year')}-${f('month')}-${f('day')}T${f('hour')}:${f('minute')}`
}
export function instantFromWall(value, zone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !validDate(value.slice(0, 10)) || !validZone(zone)) throw new Error('Invalid local date, time or time zone.')
  const nominal = Date.parse(`${value}:00Z`)
  const matches = new Set()
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = nominal + hours * 3600000
    const local = Date.parse(`${wallTime(probe, zone)}:00Z`)
    const candidate = nominal - (local - Math.floor(probe / 60000) * 60000)
    if (wallTime(candidate, zone) === value) matches.add(new Date(candidate).toISOString())
  }
  if (matches.size !== 1) throw new Error('This local time is skipped or repeated by daylight saving. Choose another time or use an explicit offset through the task API.')
  return [...matches][0]
}
