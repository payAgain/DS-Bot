import { currentPart } from './text.js'

export function reviewHome(roster) {
  return roster.byId?.[roster.mainBotId] ?? roster.bots?.find(bot => (roster.mainBotIds ?? []).includes(bot.id))
}

export function pendingReviewSources(roster, work = {}, browserHolds = {}, computer = {}) {
  return (roster.bots ?? []).map(bot => {
    const sessionId = currentPart(bot)
    const approvals = (work.approvals ?? []).filter(entry => entry.botId === bot.id)
    const pending = field => (roster[field]?.[bot.id] ?? []).filter(entry => entry.status === 'pending')
    const learning = roster.learning?.[bot.id] ?? []
    const secret = pending('secretRequests'), connector = pending('connectorRequests'), mail = pending('mailRequests')
    const question = roster.questions?.[sessionId], view = roster.views?.[sessionId]
    const browser = browserHolds[bot.id], handoff = computer.holds?.[bot.id]
    const app = Object.values(computer.asks ?? {}).some(entry => entry.botId === bot.id)
    const count = approvals.length + learning.length + secret.length + connector.length + mail.length
      + Number(Boolean(question)) + Number(Boolean(view)) + Number(Boolean(browser)) + Number(Boolean(handoff)) + Number(app)
    return { bot, sessionId, approvals, learning, secret, connector, mail, question, view, browser, handoff, app, count }
  }).filter(source => source.count > 0)
}
