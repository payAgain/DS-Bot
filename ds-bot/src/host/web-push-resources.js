import { PNG } from 'pngjs'
import { PUSH_API, PUSH_WORKER, PUSH_MANIFEST } from './web-push-policy.js'

// No fetch handler or cache: chat, API and login traffic always use the network.
export const PUSH_WORKER_SOURCE = `
const targetId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const bodies = {
  zh: { reply:'会话有新回复，点击查看。', report:'会话有新的回报，点击查看。', approval:'有请求需要你审批，点击查看。', answer:'有问题需要你回答，点击查看。', failure:'会话失败或需要处理，点击查看。', test:'这是一条 DS Bot 测试通知。' },
  en: { reply:'A conversation has a new reply.', report:'A new report is available.', approval:'A request needs your approval.', answer:'A question needs your answer.', failure:'A conversation needs attention.', test:'This is a DS Bot test notification.' },
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('push', event => {
  let data = {}
  try { data = event.data?.json() ?? {} } catch {}
  const language = data.language === 'zh' ? 'zh' : 'en'
  const kind = Object.hasOwn(bodies[language], data.kind) ? data.kind : 'reply'
  const tag = typeof data.tag === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(data.tag) ? 'dsbot-' + data.tag : 'dsbot-update'
  event.waitUntil(self.registration.showNotification('DS Bot', {
    body: bodies[language][kind], tag, renotify: false,
    data: { target: targetId(data.target) ? data.target : '' },
  }))
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = new URL('/?dsbot-pwa=1', self.location.origin)
  const target = event.notification.data?.target
  if (targetId(target)) url.searchParams.set('dsbot-push', target)
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type:'window', includeUncontrolled:true })
    for (const client of windows) {
      let current
      try { current = new URL(client.url) } catch { continue }
      if (current.origin !== self.location.origin || !['/', '/index.html'].includes(current.pathname)) continue
      try {
        const moved = await client.navigate(url.href)
        if (moved?.focus) return await moved.focus()
      } catch {}
    }
    if (self.clients.openWindow) return await self.clients.openWindow(url.href)
  })())
})
`

export function pushManifest() {
  return { id: '/ds-bot-pwa', name: 'DS Bot', short_name: 'DS Bot', start_url: '/?dsbot-pwa=1', scope: '/', display: 'standalone', background_color: '#fcfcfc', theme_color: '#fcfcfc', icons: [192, 512].map(size => ({ src: `${PUSH_API}-icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' })) }
}
// Original DS letter tiles, generated in memory; no third-party or user images.
export function pushIcon(size) {
  const png = new PNG({ width: size, height: size })
  const glyphs = ['11110100011000110001100011000111110', '01111100001000001110000010000111110']
  const scale = Math.floor(size / 18), left = Math.floor((size - 11 * scale) / 2), top = Math.floor((size - 7 * scale) / 2)
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const column = Math.floor((x - left) / scale), row = Math.floor((y - top) / scale)
    const glyph = column >= 0 && column < 5 ? 0 : column >= 6 && column < 11 ? 1 : -1
    const on = glyph >= 0 && row >= 0 && row < 7 && glyphs[glyph][row * 5 + (column - glyph * 6)] === '1'
    const offset = (y * size + x) * 4
    png.data[offset] = on ? 255 : 77; png.data[offset + 1] = on ? 255 : 107; png.data[offset + 2] = on ? 255 : 254; png.data[offset + 3] = 255
  }
  return PNG.sync.write(png)
}
export function registerPushResources(ctx) {
  const icons = new Map()
  const routes = [
    [PUSH_WORKER, () => new Response(PUSH_WORKER_SOURCE, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'service-worker-allowed': '/', 'cache-control': 'no-store' } })],
    [PUSH_MANIFEST, () => new Response(JSON.stringify(pushManifest()), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' } })],
    ...[192, 512].map(size => [`${PUSH_API}-icon-${size}.png`, () => {
      if (!icons.has(size)) icons.set(size, pushIcon(size))
      return new Response(icons.get(size), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' } })
    }]),
  ]
  for (const [path, response] of routes) ctx.effect(() => ctx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', fetch: async () => response() }), 'ds-bot: Web Push resource')
}
