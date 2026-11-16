import { createHash, ECDH } from 'node:crypto'
import { lookup } from 'node:dns'
import { Agent } from 'node:https'
import { isIP } from 'node:net'

export const PUSH_API = '/api/bot/web-push'
export const PUSH_WORKER = '/api/bot/web-push-worker.js'
export const PUSH_MANIFEST = '/api/bot/web-push-manifest.json'
export const validTarget = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
export const pushHash = value => createHash('sha256').update(value).digest('base64url')
export const pushError = (code, status = 400) => Object.assign(new Error(code), { code, status })

export function pushHostAllowed(host) {
  return host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
    || host === 'push.apple.com' || host.endsWith('.push.apple.com')
    || host.endsWith('.notify.windows.com')
}
export function publicPushAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  return isIP(address) === 6 && /^[23]/.test(address) && !address.toLowerCase().startsWith('2001:db8:')
}
export function pushAgent() {
  return new Agent({ keepAlive: false, maxSockets: 2, lookup(host, options, callback) {
    if (!pushHostAllowed(host)) { callback(pushError('push/address')); return }
    lookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error || !addresses?.length || addresses.some(entry => !publicPushAddress(entry.address))) { callback(pushError('push/address')); return }
      if (options?.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    })
  } })
}
function decode(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > 128) throw pushError('push/invalid-subscription')
  const buffer = Buffer.from(value, 'base64url')
  if (buffer.length !== bytes) throw pushError('push/invalid-subscription')
  return buffer
}
export function validatePushSubscription(value) {
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 2048) throw pushError('push/invalid-subscription')
  let url
  try { url = new URL(value.endpoint) } catch { throw pushError('push/invalid-subscription') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !pushHostAllowed(url.hostname) || url.pathname === '/') throw pushError('push/invalid-subscription')
  if (url.hostname === 'fcm.googleapis.com' && !/^\/(?:fcm\/send|wp)\//.test(url.pathname)) throw pushError('push/invalid-subscription')
  if (url.hostname === 'updates.push.services.mozilla.com' && !url.pathname.startsWith('/wpush/v2/')) throw pushError('push/invalid-subscription')
  const key = decode(value.keys?.p256dh, 65)
  try { ECDH.convertKey(key, 'prime256v1') } catch { throw pushError('push/invalid-subscription') }
  decode(value.keys?.auth, 16)
  return { endpoint: url.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } }
}
export function pushConversation(rt, sessionId) {
  const group = rt.groupOwners?.get(sessionId)
  const botId = group?.botId ?? rt.chatOwners?.get(sessionId)
  if (botId !== undefined) return { botId, target: group?.roomId ?? botId, private: rt.botOf(botId)?.private === true }
  const room = rt.roomOf?.(sessionId)
  return room ? { target: room.id, private: false } : undefined
}
