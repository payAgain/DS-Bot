// OpenMausBot-compatible connection-service protocol. Implemented for DS Bot;
// protocol references and upstream attribution are recorded in NOTICE.
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { appCatalogPage } from './app-catalog.js'

export const DEFAULT_CONNECTION_SERVICE = 'https://openmausbot-composio.milindsoni201.workers.dev'
const SLUG = /^[a-z0-9_][a-z0-9_-]{0,80}$/
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TOKEN = /^[0-9a-f]{64}$/
const fail = message => { throw Object.assign(new Error(message), { code: 'composio/managed-service' }) }
const record = value => value && typeof value === 'object' && !Array.isArray(value)

export function connectionServiceUrl(value = DEFAULT_CONNECTION_SERVICE) {
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    fail('The connection service must use HTTPS without credentials or query parameters.')
  }
  return url.href.replace(/\/+$/, '')
}

export function createManagedApps({ url, token, fetch: request = globalThis.fetch }) {
  const origin = connectionServiceUrl(url)
  let client, connecting, catalogCache, catalogFlight, closed = false
  const discovered = new Map()
  async function json(path, init = {}, signal) {
    let response
    try {
      response = await request(origin + path, {
        ...init, redirect: 'error',
        headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: signal ?? AbortSignal.timeout(30_000),
      })
    } catch {
      fail('Could not reach the connection service. Check the network connection and try again.')
    }
    if (!response.ok) {
      await response.body?.cancel()
      fail(`The connection service refused the request (HTTP ${response.status}).`)
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > 2_000_000) { await response.body?.cancel(); fail('The connection service returned too much data.') }
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength
      if (bytes > 2_000_000) fail('The connection service returned too much data.')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return JSON.parse(text)
  }
  async function mcp(signal) {
    if (closed) fail('Connected apps are stopping.')
    if (!connecting) {
      client = new Client({ name: 'ds-bot', version: '1' })
      const transport = new StreamableHTTPClientTransport(new URL(origin + '/v1/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: 'error' },
        fetch: request,
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      })
      connecting = client.connect(transport, { signal }).catch(error => {
        connecting = null
        void client.close().catch(() => {})
        throw error
      })
    }
    await connecting
    if (closed) fail('Connected apps are stopping.')
    return client
  }
  async function call(name, args, signal, beforeSend) {
    const api = await mcp(signal)
    signal?.throwIfAborted()
    beforeSend?.()
    const result = await api.callTool({ name, arguments: args }, undefined, { signal, timeout: 180_000 })
    if (result.isError) fail('The connected app could not complete the tool request.')
    if (record(result.structuredContent)) return result.structuredContent
    const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
    if (Buffer.byteLength(text) > 2_000_000) fail('The connection service returned too much data.')
    let data
    try { data = JSON.parse(text) } catch { fail('The connection service returned an unsupported tool result.') }
    if (data?.successful === false || data?.success === false) fail('The connected app could not complete the tool request.')
    return data
  }
  const schemas = result => result?.tool_schemas ?? result?.data?.tool_schemas ?? result?.data?.data?.tool_schemas ?? {}
  async function loadCatalog(signal) {
    const rows = new Map(), seen = new Set()
    let cursor, currentPage, totalItems, complete = false, reason = 'limit', warning
    for (let page = 0; page < 100; page++) {
      let result
      try {
        result = await json('/v1/catalog' + (cursor ? `?${new URLSearchParams({ cursor })}` : ''), {}, signal)
        if (!Array.isArray(result.items)) fail('The connection service returned an invalid app catalog.')
      } catch (error) {
        signal?.throwIfAborted()
        if (!rows.size) throw error
        reason = 'request-failed'; warning = error.message
        break
      }
      const before = rows.size
      for (const item of result.items) {
        if (!item || !SLUG.test(item.slug) || typeof item.name !== 'string') continue
        rows.set(item.slug, { slug: item.slug, name: item.name, noAuth: item.is_no_auth === true,
          description: typeof item.meta?.description === 'string' ? item.meta.description.slice(0, 500) : '' })
      }
      const reportedTotal = Number(result.total_items)
      if (Number.isInteger(reportedTotal) && reportedTotal > 0) totalItems = reportedTotal
      const reportedPage = Number(result.current_page)
      if ((Number.isInteger(reportedPage) && currentPage !== undefined && reportedPage <= currentPage)
        || (page > 0 && result.items.length && rows.size === before)) { reason = 'page-stuck'; break }
      if (Number.isInteger(reportedPage)) currentPage = reportedPage
      const next = typeof result.next_cursor === 'string' ? result.next_cursor.trim() : ''
      if (!next) { complete = totalItems === undefined || rows.size >= totalItems; reason = complete ? 'end' : 'total-mismatch'; break }
      if (seen.has(next)) { reason = 'cursor-repeated'; break }
      seen.add(next); cursor = next
    }
    if (!rows.size) fail('The connection service returned an invalid app catalog.')
    return { at: Date.now(), items: [...rows.values()], source: 'api', available: true,
      pagination: { complete, reason, items: rows.size, ...(totalItems ? { totalItems } : {}) },
      ...(!complete ? { warning: warning ?? 'The connection service returned an incomplete app catalog.' } : {}) }
  }
  const api = {
    kind: 'managed',
    async register(signal) {
      const result = await json('/v1/installations', { method: 'POST', body: '{}' }, signal)
      if (!TOKEN.test(result.token) || typeof result.installationId !== 'string' || !ACCOUNT.test(result.installationId)) {
        fail('The connection service returned an invalid installation.')
      }
      token = result.token
      return result
    },
    async catalog(options = {}, signal) {
      if (closed) fail('Connected apps are stopping.')
      if (!catalogCache || Date.now() - catalogCache.at >= 10 * 60_000) {
        catalogFlight ??= loadCatalog(signal).finally(() => { catalogFlight = null })
        catalogCache = await catalogFlight
      }
      const { items, at: _at, ...metadata } = catalogCache
      return { ...metadata, ...appCatalogPage(items, options) }
    },
    async accounts(signal) {
      const result = await json('/v1/connectors/connected', {}, signal)
      if (!record(result.services)) fail('The connection service returned an invalid connected-app inventory.')
      return Object.entries(result.services).flatMap(([toolkit, service]) => {
        if (!SLUG.test(toolkit)) return []
        return (Array.isArray(service.accounts) ? service.accounts : []).filter(account => ACCOUNT.test(account.id))
          .map(account => ({ id: account.id, toolkit, label: String(account.alias || toolkit).slice(0, 200),
            status: String(account.status ?? 'UNKNOWN').toUpperCase(), disabled: false }))
      })
    },
    async authorize(toolkit, label, signal) {
      if (!SLUG.test(toolkit)) fail('Choose an application.')
      return json(`/v1/connectors/${toolkit}/authorize`, { method: 'POST', body: JSON.stringify({ alias: label || `DS Bot ${randomUUID().slice(0, 8)}` }) }, signal)
    },
    async disconnect(account, signal) {
      if (!SLUG.test(account.toolkit) || !ACCOUNT.test(account.id)) fail('Choose a connected account.')
      return json(`/v1/connectors/${account.toolkit}/accounts/${account.id}`, { method: 'DELETE' }, signal)
    },
    async search(account, query, signal) {
      const result = await call('COMPOSIO_SEARCH_TOOLS', {
        queries: [{ use_case: `${account.toolkit}: ${query}` }], session: { generate_id: true },
      }, signal)
      let found = Object.values(schemas(result)).filter(item => item.toolkit === account.toolkit
        && /^[A-Z0-9_]{1,160}$/.test(item.tool_slug) && !item.tool_slug.startsWith('COMPOSIO_')).slice(0, 20)
      const missing = found.filter(item => !record(item.input_schema)).map(item => item.tool_slug)
      if (missing.length) {
        const full = await call('COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: missing,
          ...(result.session?.id || result.data?.session?.id ? { session_id: result.session?.id ?? result.data.session.id } : {}) }, signal)
        const loaded = schemas(full)
        found = found.map(item => ({ ...item,
          input_schema: loaded[item.tool_slug]?.input_schema ?? item.input_schema }))
      }
      return found.filter(item => record(item.input_schema)).map(item => {
        const tool = { slug: item.tool_slug, name: item.tool_slug, description: String(item.description ?? '').slice(0, 2000),
          inputParameters: item.input_schema, toolkit: { slug: account.toolkit },
          version: `discovery-${randomUUID()}`, tags: item.annotations?.readOnlyHint === true ? ['readOnlyHint'] : [] }
        discovered.set(tool.version, { tool, accountId: account.id, sessionId: result.session?.id ?? result.data?.session?.id })
        if (discovered.size > 200) discovered.delete(discovered.keys().next().value)
        return tool
      })
    },
    tool(slug, version, accountId) {
      const held = discovered.get(version)
      if (!held || held.tool.slug !== slug || held.accountId !== accountId) fail('Search this connected app before executing its tool.')
      return held.tool
    },
    async execute(account, slug, version, args, signal, beforeSend) {
      const tool = api.tool(slug, version, account.id)
      const active = (await api.accounts(signal)).filter(item => item.toolkit === tool.toolkit.slug && item.status === 'ACTIVE')
      // This adapter has no verified account-pinning field for the MCP call.
      // Refuse ambiguous calls rather than silently using another account.
      if (!account.public && (active.length !== 1 || active[0].id !== account.id)) {
        fail('This service requires one active account per app for tool execution.')
      }
      const held = discovered.get(version)
      return call('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: slug, arguments: args }],
        sync_response_to_workbench: false, ...(held.sessionId ? { session_id: held.sessionId } : {}) }, signal, beforeSend)
    },
    async close() {
      closed = true
      discovered.clear()
      await client?.close()
    },
  }
  return api
}
