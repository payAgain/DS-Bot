import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WebPushStore } from './web-push-store.js'
import { registerPushResources } from './web-push-resources.js'
import { PUSH_API, pushHash, pushError, validTarget, pushConversation } from './web-push-policy.js'
import { textOf } from './text.js'

const cookieToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
export function pushRequestDevice(request) {
  const host = (request.headers.get('host') ?? '').toLowerCase()
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
  const name = local ? 'dsbot_push_device' : '__Host-dsbot-push-device'
  const value = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1)
  const token = cookieToken(value) ? value : randomBytes(32).toString('base64url')
  return { owner: pushHash(token), token, existing: cookieToken(value), cookie: `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${local ? '' : '; Secure'}` }
}
export function requirePushOrigin(request) {
  let origin
  try { origin = new URL(request.headers.get('origin')) } catch { throw pushError('push/origin', 403) }
  const host = (request.headers.get('host') ?? '').toLowerCase()
  if (origin.host.toLowerCase() !== host || (origin.protocol !== 'https:' && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin.origin))
    || request.headers.get('sec-fetch-site') === 'cross-site' || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw pushError('push/origin', 403)
}

export function install(rt, { makeStore = options => new WebPushStore(options) } = {}) {
  const { ctx, state } = rt
  const directory = join(rt.home, 'web-push')
  let ready, disposed = false
  const targetAllowed = (target, device) => {
    if (!validTarget(target)) return false
    const bot = rt.botOf(target)
    if (bot) return bot.private !== true || device.includePrivate === true
    const room = rt.roomOf(target)
    return room !== undefined && (room.private !== true || device.includePrivate === true)
  }
  const getStore = () => ready ??= Promise.resolve().then(async () => {
    await rt.load()
    if (disposed) throw pushError('push/unavailable', 503)
    return makeStore({ directory, writable: () => !disposed && rt.readOnly() === undefined, targetAllowed }).init()
  })
  // No device store means no subscriptions. Normal chat activity creates no keys.
  if (existsSync(join(directory, 'vapid.json'))) void getStore().catch(() => {})
  const emit = (key, kind, place) => {
    if (!ready || !place) return
    void ready.then(store => store.emit(key, kind, place.target, place.private)).catch(() => {})
  }
  const scanRequests = () => {
    if (!ready) return
    for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
      if (!question?.id || question.outcome || (question.status !== undefined && question.status !== 'pending')) continue
      emit(`answer:${question.id}`, 'answer', pushConversation(rt, sessionId))
    }
    for (const [sessionId, view] of Object.entries(state.views ?? {})) {
      if (!view?.id || view.outcome || (view.status !== undefined && view.status !== 'pending')) continue
      emit(`view:${view.id}`, 'answer', pushConversation(rt, sessionId))
    }
    for (const approval of rt.approvalsView?.() ?? []) {
      const home = state.mainBotIds?.find(id => rt.botOf(id))
      const place = pushConversation(rt, approval.sessionId)
      emit(`approval:${approval.sessionId}:${approval.callId ?? approval.id}`, 'approval', place ? { ...place, ...(home ? { target: home } : {}) } : undefined)
    }
  }
  const offSaved = rt.onSaved(scanRequests)
  const offApproval = rt.onApproval?.((kind, entry) => {
    if (kind !== 'open') return
    const place = pushConversation(rt, entry.sessionId)
    const home = state.mainBotIds?.find(id => rt.botOf(id))
    emit(`approval:${entry.sessionId}:${entry.callId ?? entry.id}`, 'approval', place ? { ...place, ...(home ? { target: home } : {}) } : undefined)
  })
  const turns = new Map()
  ctx.on('session/event', (session, event) => {
    if (!ready || !rt.chatOwners.has(session.id)) return
    if (event.type === 'turn/start') turns.set(session.id, { turn: event.data?.turn, text: '', called: false })
    const own = turns.get(session.id) ?? { turn: event.data?.turn ?? rt.live?.get(session.id)?.turn, text: '', called: false }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.kind === 'bot' && source.role === 'reply') own.report = true
      turns.set(session.id, own)
    }
    if (event.type === 'assistant/message') {
      own.text = textOf(event.data?.message?.content).trim()
      own.called = event.data?.message?.content?.some(block => block.type === 'tool-call') === true
      own.delegated ||= event.data?.message?.content?.some(block => block.type === 'tool-call' && ['message_bot', 'post_to_group', 'subagent'].includes(block.name)) === true
      turns.set(session.id, own)
    }
    if (event.type !== 'turn/end') return
    turns.delete(session.id)
    if ((state.exchangeTurns[session.id] ?? []).includes(own.turn)) return
    const place = pushConversation(rt, session.id), reason = event.data?.reason
    if (reason?.kind === 'error') emit(`failure:${session.id}:${event.seq}`, 'failure', place)
    else if (reason?.kind === 'completed') {
      const waiting = rt.waitingView?.()?.[place?.botId]
      if ((own.delegated || own.report) && ((waiting?.bots?.length ?? 0) + (waiting?.rooms?.length ?? 0) > 0)) return
      if (own.text && !own.called && !/^\[(?:SILENT|HANDOFF_ACK|PASS)\]$/i.test(own.text)) emit(`reply:${session.id}:${event.seq}`, 'reply', place)
      else if (own.report) emit(`report:${session.id}:${event.seq}`, 'report', place)
    }
  })
  registerPushResources(ctx)
  ctx.effect(() => ctx.connection.fetch.register({
    path: PUSH_API, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async request => {
      const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
      try {
        const store = await getStore(), device = pushRequestDevice(request)
        if (request.method === 'GET') {
          headers['set-cookie'] = device.cookie
          return new Response(JSON.stringify({ ok: true, publicKey: store.keys.publicKey, csrf: store.csrf(device.token), ...store.status(device.owner) }), { headers })
        }
        requirePushOrigin(request)
        if (!device.existing || !store.checkCsrf(device.token, request.headers.get('x-dsbot-push-csrf'))) throw pushError('push/csrf', 403)
        const raw = await request.text()
        if (raw.length > 8192) throw pushError('push/too-large', 413)
        let body
        try { body = JSON.parse(raw) } catch { throw pushError('push/invalid-request') }
        let value
        if (body.action === 'subscribe') {
          value = await store.subscribe(device.owner, body.subscription, { includePrivate: body.includePrivate, language: body.language })
          scanRequests()
        } else if (body.action === 'unsubscribe') value = await store.unsubscribe(device.owner)
        else if (body.action === 'test') value = await store.test(device.owner)
        else throw pushError('push/invalid-request')
        return new Response(JSON.stringify({ ok: true, ...value }), { headers })
      } catch (error) {
        // Never serialize provider errors, URLs, cookie material or encryption keys.
        const code = typeof error?.code === 'string' && error.code.startsWith('push/') ? error.code : 'push/unavailable'
        return new Response(JSON.stringify({ ok: false, code }), { status: error.status ?? 503, headers })
      }
    },
  }), 'ds-bot: owned Web Push API')
  ctx.effect(() => () => {
    disposed = true
    offSaved(); offApproval?.(); turns.clear()
    return ready?.then(store => store.stop()).catch(() => {})
  }, 'ds-bot: Web Push lifecycle')
}
