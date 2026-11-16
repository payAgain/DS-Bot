import { createElement as h } from 'react'
import { t } from './i18n.js'
import { contentText, stripHeader, toolName } from './text.js'

export const isSilentReply = text => /^\s*\[SILENT\]\s*$/i.test(text)
const textOf = blocks => (blocks ?? []).filter(block => block?.kind === 'text').map(block => block.text ?? '').join('\n').trim()
export function receiptOrigins(origins = []) {
  const seen = new Set()
  return origins.filter(origin => {
    const source = origin?.source
    if (source?.kind !== 'schedule' && !(source?.kind === 'bot' && source.role === 'reply')) return false
    const key = source.exchangeId ?? source.replyTo ?? origin.seq ?? `${source.kind}:${origin.time}:${contentText(origin.content)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// A transcript projection only: no write, delivery, task mutation or model call.
export function scheduledReceipt({ origins, steps = [], turn, closing }) {
  if (turn?.status !== 'closed') return null
  const sources = receiptOrigins(origins)
  if (sources.length === 0) return null
  const reply = textOf(closing?.blocks ?? steps.at(-1)?.blocks)
  if (reply && !isSilentReply(reply)) return null
  const reason = turn.end?.data?.reason
  const failed = reason?.kind === 'error' || reason?.kind === 'aborted'
  const reports = sources.filter(origin => origin.source.kind === 'bot')
  if (reports.length) return {
    kind: failed ? 'failed' : 'replied',
    time: turn.end?.time,
    sources: reports.map(origin => ({ name: origin.source.senderName ?? '', time: origin.time, text: stripHeader(contentText(origin.content)).trim().slice(0, 6000) })),
  }
  const scheduled = sources[0]
  const frame = contentText(scheduled.content)
  const occurrence = /^occurrence_at: (\S+)$/m.exec(frame)?.[1]
  let occurrences = occurrence ? [occurrence] : []
  try {
    const batch = /^reminders_json: (.*)$/m.exec(frame)
    if (batch) {
      const parsed = JSON.parse(batch[1])
      if (Array.isArray(parsed)) occurrences = parsed.slice(0, 100).map(item => item?.occurrence_at)
    }
  } catch {}
  occurrences = [...new Set(occurrences.filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))))]
  const asked = steps.some(step => (step.blocks ?? []).some(block => block.kind === 'tool-call' && ['message_bot', 'post_to_group', 'subagent'].includes(toolName(block))))
  return { kind: failed ? 'failed' : asked ? 'awaiting' : 'unknown', time: turn.end?.time, occurrence: occurrences[0], occurrences, sources: [] }
}

const TITLES = {
  replied: 'Report received',
  awaiting: 'Collaboration requested',
  unknown: 'Scheduled result not confirmed',
  failed: 'Response failed or stopped',
}
function clock(time) {
  return typeof time === 'number' && Number.isFinite(time) ? new Date(time).toLocaleString() : ''
}
export function ScheduledReceipt({ receipt }) {
  if (!receipt) return null
  return h('div', { className: 'bt-scheduled-receipt', 'data-kind': receipt.kind, role: 'status', 'aria-label': t('Task receipt') },
    h('div', { className: 'bt-receipt-head' }, h('strong', null, t(TITLES[receipt.kind])), receipt.time ? h('time', { dateTime: new Date(receipt.time).toISOString() }, clock(receipt.time)) : null),
    receipt.occurrences?.length ? h('div', { className: 'bt-receipt-meta' }, t('Scheduled occurrence: {time}', { time: receipt.occurrences.map(value => clock(Date.parse(value))).join(' · ') })) : null,
    receipt.sources.length ? receipt.sources.map((source, index) => h('div', { key: index, className: 'bt-receipt-source' },
      h('div', { className: 'bt-receipt-meta' }, t('Source: {name}', { name: source.name || t('a Bot') }), source.time ? ` · ${clock(source.time)}` : ''),
      source.text && !isSilentReply(source.text) ? h('details', null, h('summary', null, source.text.slice(0, 180)), h('div', { className: 'bt-receipt-body' }, source.text)) : h('div', null, t('No readable conclusion was provided.')),
    )) : h('div', null, t(receipt.kind === 'awaiting' ? 'This receipt records the request, not its outcome.' : 'Delivery is not completion. The result has not been confirmed.')),
  )
}

export const RECEIPT_CSS = `
.bt-scheduled-receipt{box-sizing:border-box;max-width:100%;margin:8px 0;padding:10px 12px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink-2);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.bt-receipt-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 12px;color:var(--bt-ink)}
.bt-receipt-head strong{font-weight:500}.bt-receipt-head time,.bt-receipt-meta{font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-receipt-source{margin-top:6px}.bt-receipt-source summary{cursor:pointer;white-space:pre-wrap}.bt-receipt-body{white-space:pre-wrap;max-height:240px;overflow:auto;padding-top:6px}
.bt-scheduled-receipt[data-kind=failed] .bt-receipt-head{color:var(--bt-danger)}
`
