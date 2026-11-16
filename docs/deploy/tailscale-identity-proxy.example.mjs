import http from 'node:http'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { open, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const IDENTITY = 'tailscale-user-login'
const FORWARDED = /^tailscale-/i

function deny(response, status, message) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  response.end(message)
}

function secureCookies(value) {
  return (Array.isArray(value) ? value : value ? [value] : []).map(cookie =>
    /;\s*secure(?:;|$)/i.test(cookie) ? cookie : cookie + '; Secure',
  )
}

export function parseLoginUrl(text, origin) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '')
  const raw = [...clean.matchAll(/dsh web:\s*(https?:\/\/[^\s]+)/g)].at(-1)?.[1]
  if (!raw) throw Error('LOGIN_NOT_READY')
  const url = new URL(raw)
  if (url.origin !== origin || url.pathname !== '/' || url.hash || url.username || url.password
    || url.searchParams.getAll('token').length !== 1 || !url.searchParams.get('token')) throw Error('LOGIN_NOT_READY')
  return url
}

export async function readLoginUrl(logPath, origin) {
  const file = await open(logPath, 'r')
  try {
    const { size } = await file.stat()
    const buffer = Buffer.alloc(Math.min(size, 1024 * 1024))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length))
    return parseLoginUrl(buffer.subarray(0, bytesRead).toString('utf8'), origin)
  } finally { await file.close() }
}

const forwardHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([name]) => !FORWARDED.test(name)))

// Preserve only the app's fixed PWA/notification entry, never an arbitrary return URL.
export function homeDestination(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return null
  const url = new URL(raw, 'https://local.invalid')
  if (!['/', '/index.html'].includes(url.pathname) || url.hash) return null
  if (!url.search) return '/'
  const keys = [...url.searchParams.keys()]
  if (keys.some(key => !['dsbot-pwa', 'dsbot-pwa-setup', 'dsbot-push', 'dsbot-sso'].includes(key)) || new Set(keys).size !== keys.length) return null
  const pwa = url.searchParams.get('dsbot-pwa'), resume = url.searchParams.get('dsbot-sso')
  const setup = url.searchParams.get('dsbot-pwa-setup'), target = url.searchParams.get('dsbot-push')
  if (resume !== null && resume !== '1') return null
  if (pwa === null) return resume === '1' && setup === null && target === null ? '/' : null
  if (pwa !== '1' || (setup !== null && setup !== '1')) return null
  if (target !== null && !/^[A-Za-z0-9_-]{1,160}$/.test(target)) return null
  return '/?dsbot-pwa=1' + (setup ? '&dsbot-pwa-setup=1' : '') + (target ? '&dsbot-push=' + encodeURIComponent(target) : '')
}

// A committed same-origin document ends an external navigation's redirect chain before
// Safari sends the unchanged Strict session cookie. The marker is a retry bound only.
function sessionPage(response, destination, cookies) {
  const nonce = randomBytes(18).toString('base64')
  const resume = destination + (destination.includes('?') ? '&' : '?') + 'dsbot-sso=1'
  const ready = Boolean(cookies)
  const retry = (ready ? resume : destination).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  const title = ready ? '正在建立安全会话' : '浏览器未能建立登录会话'
  const message = ready ? '正在以同源页面完成登录，请稍候。' : '浏览器没有发送有效的登录 Cookie，自动恢复已停止。请在 Safari 中直接打开此网址后重试；无需清除所有浏览记录。若仍失败，请报告此提示。'
  response.writeHead(ready ? 200 : 409, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    ...(ready ? { 'set-cookie': cookies } : {}),
  })
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><body><h1>${title}</h1><p>${message}</p><p><a href="${retry}">${ready ? '继续打开 DS Bot' : '重新建立会话'}</a></p>${ready ? `<script nonce="${nonce}">window.addEventListener('load',function(){location.replace(${JSON.stringify(resume)})},{once:true})</script>` : ''}</body></html>`)
}

export function createSsoProxy(config, { loadLogin = () => readLoginUrl(config.launchLog, new URL(config.publicOrigin).origin) } = {}) {
  let publicUrl
  try { publicUrl = new URL(config.publicOrigin) } catch { throw Error('INVALID_CONFIG') }
  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash
    || publicUrl.username || publicUrl.password || config.upstreamHost !== '127.0.0.1'
    || !Number.isInteger(config.upstreamPort) || config.upstreamPort < 1 || config.upstreamPort > 65535
    || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
    || typeof config.allowedLogin !== 'string' || !config.allowedLogin.trim()) throw Error('INVALID_CONFIG')
  const allowedLogin = config.allowedLogin.trim().toLowerCase()
  const acceptedHosts = new Set([publicUrl.host.toLowerCase()])
  if (!publicUrl.port) acceptedHosts.add(publicUrl.hostname.toLowerCase() + ':443')
  let currentLogin

  const identityAllowed = request => {
    const login = request.headers[IDENTITY]
    if (typeof login !== 'string' || login.trim().toLowerCase() !== allowedLogin) return false
    if (!acceptedHosts.has(String(request.headers.host ?? '').toLowerCase())) return false
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      // A trusted tailnet user may open the home page from an external link.
      // Keep cross-site API, asset, unrelated query and WebSocket requests forbidden.
      const homeNavigation = request.method === 'GET'
        && homeDestination(request.url) !== null
        && request.headers['sec-fetch-mode'] === 'navigate'
        && request.headers['sec-fetch-dest'] === 'document'
      if (!homeNavigation) return false
    }
    if (request.headers.origin) {
      try { if (new URL(request.headers.origin).origin !== publicUrl.origin) return false }
      catch { return false }
    }
    return true
  }
  const loginUrl = async () => {
    try { currentLogin = await loadLogin() }
    catch (error) { if (!currentLogin) throw error }
    if (!(currentLogin instanceof URL) || currentLogin.origin !== publicUrl.origin
      || currentLogin.pathname !== '/' || !currentLogin.searchParams.get('token')) throw Error('LOGIN_NOT_READY')
    return currentLogin
  }

  const server = http.createServer((request, response) => {
    if (!identityAllowed(request)) return deny(response, 403, '仅允许已授权的 Tailscale 账号访问。')
    const url = new URL(request.url, publicUrl)
    const firstPage = request.method === 'GET' && ['/', '/index.html'].includes(url.pathname)
      && !url.searchParams.has('token')
    const upstream = http.request({ host: config.upstreamHost, port: config.upstreamPort,
      method: request.method, path: request.url, headers: forwardHeaders(request.headers) }, result => {
      result.on('error', () => response.destroy())
      if (firstPage && result.statusCode === 401) {
        result.resume()
        const destination = homeDestination(request.url)
        if (destination === null) return deny(response, 400, '登录入口参数无效，请从应用首页打开。')
        if (url.searchParams.get('dsbot-sso') === '1') return sessionPage(response, destination)
        return exchangeLogin(request, response)
      }
      const headers = { ...result.headers }
      if (headers['set-cookie']) headers['set-cookie'] = secureCookies(headers['set-cookie'])
      response.writeHead(result.statusCode, headers)
      result.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) deny(response, 502, 'DSH 网关暂不可用。'); else response.destroy() })
    request.on('aborted', () => upstream.destroy())
    response.once('close', () => { if (!response.writableEnded) upstream.destroy() })
    request.pipe(upstream)
  })

  function exchangeLogin(request, response, retried = false) {
    loginUrl().then(url => {
      const upstream = http.request({ host: config.upstreamHost, port: config.upstreamPort,
        method: 'GET', path: url.pathname + url.search,
        headers: { ...forwardHeaders(request.headers), connection: 'close' } }, result => {
        result.on('error', () => { if (!response.headersSent) deny(response, 502, 'DSH 网关暂不可用。') })
        result.resume()
        const cookies = secureCookies(result.headers['set-cookie'])
        if (result.statusCode !== 303 || !cookies.length) {
          currentLogin = undefined
          if (!retried) return exchangeLogin(request, response, true)
          return deny(response, 503, 'DSH 登录入口尚未就绪，请稍后重试。')
        }
        sessionPage(response, homeDestination(request.url) ?? '/', cookies)
      })
      upstream.setTimeout(10000, () => upstream.destroy())
      upstream.on('error', () => { if (!response.headersSent) deny(response, 502, 'DSH 网关暂不可用。') })
      response.once('close', () => { if (!response.writableEnded) upstream.destroy() })
      upstream.end()
    }).catch(() => { if (!response.headersSent) deny(response, 503, 'DSH 登录入口尚未就绪。') })
  }

  server.on('upgrade', (request, socket, head) => {
    if (!identityAllowed(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const upstream = net.connect(config.upstreamPort, config.upstreamHost)
    upstream.once('connect', () => {
      let message = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`
      for (const [name, value] of Object.entries(forwardHeaders(request.headers))) {
        if (Array.isArray(value)) for (const item of value) message += `${name}: ${item}\r\n`
        else if (value !== undefined) message += `${name}: ${value}\r\n`
      }
      upstream.write(message + '\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const server = createSsoProxy(config)
    server.listen(config.port, '127.0.0.1')
    server.once('listening', () => console.log('Tailscale identity proxy ready on loopback'))
    let closing = false
    const stop = () => {
      if (closing) return
      closing = true
      server.close(() => process.exit(0))
      server.closeAllConnections()
      setTimeout(() => process.exit(0), 5000).unref()
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  } catch { console.error('Tailscale identity proxy could not start; inspect its private configuration'); process.exitCode = 1 }
}
