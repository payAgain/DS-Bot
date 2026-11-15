import { useMemo } from 'react'
import { currentPart } from './text.js'
import { workPhrase } from './cells.js'
import { t } from './i18n.js'

export const pendingStatus = entry => Boolean(entry && !entry.outcome && (entry.status === undefined || entry.status === 'pending'))
const model = (kind, text, extra = {}) => ({ kind, text, active: kind === 'working', alert: kind === 'approval' || kind === 'answer', waiting: kind === 'waiting', ...extra })
function waitingText(roster, waits) {
  const names = [...(waits?.bots ?? []).map(id => roster.byId?.[id]?.name), ...(waits?.rooms ?? []).map(id => roster.roomsById?.[id]?.name)].filter(Boolean)
  return names.length ? t('Waiting for {names}', { names: names.join(t(' and ')) }) : ''
}
// The same live evidence drives the narrow header and the team drawer. A saved
// preview, last response and activity category on their own never mean "busy".
export function conversationStatus({ sessionId, roster, work = {}, running = false, activity }) {
  const bot = roster.byId?.[sessionId]
  const room = roster.roomsById?.[sessionId]
  if (bot) {
    const part = currentPart(bot)
    const approval = (work.approvals ?? []).some(entry => entry.botId === bot.id && pendingStatus(entry))
    const question = pendingStatus(roster.questions?.[part]) || pendingStatus(roster.views?.[part])
    if (approval) return model('approval', t('Waiting for your approval'))
    if (question) return model('answer', t('Waiting for your answer'))
    const own = work.bots?.[bot.id]
    if (running || own) return model('working', `${workPhrase(own ?? activity)}…`, { doing: own ?? activity })
    const groups = Object.entries(work.rooms ?? {}).flatMap(([id, entries]) => entries.filter(entry => entry.botId === bot.id).map(entry => ({ ...entry, roomId: id })))
    if (groups.length) return model('working', `${roster.roomsById?.[groups[0].roomId]?.name ?? t('a group chat')} · ${workPhrase(groups[0])}…${groups.length > 1 ? ` +${groups.length - 1}` : ''}`, { doing: groups[0] })
    const waiting = waitingText(roster, work.waiting?.[bot.id])
    if (waiting) return model('waiting', waiting)
    if (typeof bot.blocked?.code === 'string' && bot.blocked.code !== '') return model('blocked', t('Needs attention'))
    return model('idle', t('Idle'))
  }
  if (room) {
    const part = room.sessionId ?? room.id
    if ((work.approvals ?? []).some(entry => entry.roomId === room.id && pendingStatus(entry))) return model('approval', t('Waiting for your approval'))
    if (pendingStatus(roster.questions?.[part]) || pendingStatus(roster.views?.[part])) return model('answer', t('Waiting for your answer'))
    const members = (work.rooms?.[room.id] ?? []).filter(entry => roster.byId?.[entry.botId])
    if (members.length) {
      const first = members[0]
      const lead = members.length === 1 ? roster.byId?.[first.botId].name : `${t('{count} Bots working', { count: members.length })} · ${roster.byId?.[first.botId].name}`
      return model('working', `${lead} · ${workPhrase(first)}…`, { doing: first })
    }
    if (running) return model('working', `${t('Working')}…`)
    const waiting = waitingText(roster, work.waiting?.[room.id])
    return waiting ? model('waiting', waiting) : model('idle', t('Idle'))
  }
  return model('unknown', roster.ready ? '' : t('Loading…'))
}

export function useConversationStatus({ sessionId, roster, useWork, useSessionStatus, useActivity }) {
  const bot = roster.byId?.[sessionId]
  const room = roster.roomsById?.[sessionId]
  const part = bot ? currentPart(bot) : room?.sessionId ?? sessionId
  const running = useSessionStatus(map => map.get(part)?.running === true)
  const activity = useActivity ? useActivity(map => bot ? map[bot.id] : undefined) : undefined
  const key = useWork ? useWork(work => JSON.stringify(work)) : '{}'
  const work = useMemo(() => JSON.parse(key), [key])
  return conversationStatus({ sessionId, roster, work, running, activity })
}


export const MOBILE_STATUS_CSS = `
.bt-pill-labels{display:contents}
.bt-mobile-chat-status{display:none}
@media(max-width:700px){
.bt-head{height:56px}
.bt-pill{height:56px}
.bt-pill-labels{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;min-width:0;flex:1 1 auto;text-align:left}
.bt-pill-labels>.bt-pill-name,.bt-pill-labels>.bt-pill-swap{max-width:100%;width:100%;min-width:0}
.bt-mobile-chat-status{display:block;min-width:0;max-width:100%;height:16px;line-height:16px;font-size:12px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--bt-ink-2)}
.bt-mobile-chat-status[data-kind=idle]{color:var(--bt-ink-3)}
.bt-mobile-chat-status:is([data-kind=approval],[data-kind=answer],[data-kind=waiting]){color:var(--bt-accent)}
.bt-mobile-chat-status[data-kind=blocked]{color:var(--bt-danger)}
header[class*="_header"]:has(.bt-head)::before{height:calc(76px + env(safe-area-inset-top,0px))}
header[class*="_header"]:has(.bt-head)>[class*="_headerLeading"]{top:18px!important}
[class*="_scroll"]:has(> [class*="_column"]){padding-top:calc(76px + env(safe-area-inset-top,0px))!important}
body[data-bt-goal] [class*="_scroll"]:has(> [class*="_column"]){padding-top:calc(106px + env(safe-area-inset-top,0px))!important}
}
`
