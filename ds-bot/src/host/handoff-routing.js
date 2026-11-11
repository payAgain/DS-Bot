// Rebuild routing only, without replaying tools, writes or deliveries from history.
import { SOURCE_KIND, HANDOFF_ACK, STEER_CUT } from './constants.js'
import { textOf } from './text.js'

const owes = source => source && (source.role === 'request' || source.role === 'stopped') && source.audience !== 'user'
const workOf = source => source?.role === 'request' && source.audience !== 'user' ? source.exchangeId : source?.work
const bodyOf = content => textOf(content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')

export function routingFromEvents(events) {
  let entry
  let carry
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      entry = { turn: data.turn, since: event.time, texts: [], shown: 0, joined: [], later: [], opened: false, toolCount: 0, ...carry }
      carry = undefined
    }
    if (!entry) continue
    if (event.type === 'user/message') {
      const source = data.source
      const bare = source?.handoff === true && source.resume !== true
      const opened = entry.opened
      if (!bare && ['user', 'bot', 'bot-reply', 'schedule'].includes(source?.kind)) entry.opened = true
      if (source?.kind !== SOURCE_KIND) continue
      if (!opened) {
        entry.info = source
        if (Array.isArray(source.joined)) entry.joined = source.joined
      } else if (source.work && source.work !== workOf(entry.info) && !owes(source)) {
        entry.later.push({ info: source, text: bodyOf(data.content) })
      } else if ((owes(source) || source.role === 'room') && source.exchangeId !== entry.info?.exchangeId
        && !entry.joined.some(item => item.info.exchangeId === source.exchangeId)) {
        entry.joined.push({ info: source, text: bodyOf(data.content) })
      }
    }
    if (event.type === 'assistant/message') {
      const text = textOf(data.message?.content)
      if (text && text !== HANDOFF_ACK) entry.texts.push(text)
      entry.lastText = text
      entry.lastCalled = data.message?.content?.some(block => block.type === 'tool-call')
    }
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') entry.toolCount += 1
    if (event.type === 'step/start') entry.stepFrom = entry.texts.length
    if (event.type === 'turn/end') {
      if (data.reason?.kind === 'aborted' && data.reason.reason?.reason === STEER_CUT) {
        carry = { ...entry, texts: entry.texts.slice(0, entry.stepFrom ?? entry.texts.length) }
        delete carry.turn
      }
      entry = undefined
    }
  }
  return entry
}
