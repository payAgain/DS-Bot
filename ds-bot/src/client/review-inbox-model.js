import { currentPart } from './text.js'

export function reviewHome(roster) {
  return roster.byId?.[roster.mainBotId] ?? roster.bots?.find(bot => (roster.mainBotIds ?? []).includes(bot.id))
}

const active = entry => entry && !entry.outcome && (entry.status === undefined || entry.status === 'pending')
const unique = entries => [...new Map(entries.filter(active).map(entry => [entry.id ?? entry.callId ?? entry, entry])).values()]

export function pendingAppAsks(computer, botId) {
  return unique(Object.entries(computer.asks ?? {}).map(([id, ask]) => ({ ...ask, id: ask.id ?? id })).filter(ask => ask.botId === botId))
}

export function pendingReviewSources(roster, work = {}, browserHolds = {}, computer = {}) {
  return (roster.bots ?? []).map(bot => {
    const sessionId = currentPart(bot)
    const approvals = unique((work.approvals ?? []).filter(entry => entry.botId === bot.id))
    const pending = field => unique((roster[field]?.[bot.id] ?? []).filter(entry => entry.status === 'pending'))
    const learning = unique(roster.learning?.[bot.id] ?? [])
    const secret = pending('secretRequests'), connector = pending('connectorRequests'), mail = pending('mailRequests')
    const live = entry => active(entry) ? entry : undefined
    const question = live(roster.questions?.[sessionId]), view = live(roster.views?.[sessionId])
    const browser = live(browserHolds[bot.id]), handoff = live(computer.holds?.[bot.id])
    const apps = pendingAppAsks(computer, bot.id)
    const count = approvals.length + learning.length + secret.length + connector.length + mail.length
      + Number(Boolean(question)) + Number(Boolean(view)) + Number(Boolean(browser)) + Number(Boolean(handoff)) + apps.length
    return { bot, sessionId, approvals, learning, secret, connector, mail, question, view, browser, handoff, apps, app: apps.length > 0, count }
  }).filter(source => source.count > 0)
}

// Match the live request by its original call, never by title, app name or Bot alone.
export function reviewForCall(roster, sessionId, callId, browserHolds = {}, computer = {}) {
  if (!callId) return undefined
  const bot = roster.byId?.[sessionId]
  if (!bot) return undefined
  const source = pendingReviewSources(roster, {}, browserHolds, computer).find(entry => entry.bot.id === bot.id)
  if (!source) return undefined
  return [source.question, source.view, source.browser, source.handoff, ...source.apps, ...source.secret, ...source.connector, ...source.mail]
    .find(entry => entry?.callId === callId)
}

export function waitingForReview(roster, sessionId, work = {}, browserHolds = {}, computer = {}) {
  const bot = roster.byId?.[sessionId]
  if (!bot) return false
  const source = pendingReviewSources(roster, work, browserHolds, computer).find(entry => entry.bot.id === bot.id)
  // Background learning suggestions do not block a running turn.
  return Boolean(source && source.count > source.learning.length)
    || ['waiting', 'user'].includes(computer.bots?.[bot.id]?.state)
}
