import { randomUUID } from 'node:crypto'
import { Composio } from '@composio/core'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { own } from '../store.js'
import { output } from '../tools.js'
import { createManagedApps, connectionServiceUrl } from './managed-apps.js'
import { appCatalogPage, CURATED_APPS } from './app-catalog.js'

const KEY = 'DSBOT_COMPOSIO_PROJECT_KEY'
const SERVICE_TOKEN = 'DSBOT_CONNECTED_APPS_INSTALLATION_TOKEN'
const ID = /^[a-zA-Z0-9_-]{1,128}$/
const validId = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
const SLUG = /^[a-z0-9_][a-z0-9_-]{0,80}$/
const fail = (message, code = 'invalid') => { throw Object.assign(new Error(message), { code: `composio/${code}` }) }
const text = (value, maximum = 200) => typeof value === 'string' ? value.trim().slice(0, maximum) : ''
const makeClient = apiKey => new Composio({ apiKey, userApiKey: null, orgApiKey: null,
  baseURL: 'https://backend.composio.dev', allowTracking: false, logLevel: 'silent',
  dangerouslyAllowAutoUploadDownloadFiles: false, fileUploadDirs: false })
const responseStatus = error => [error?.status, error?.statusCode, error?.cause?.status, error?.cause?.statusCode]
  .find(status => Number.isInteger(status) && status >= 400 && status <= 599)
const safeError = error => {
  if (String(error?.code ?? '').startsWith('composio/')) return error
  const status = responseStatus(error)
  return Object.assign(new Error(status === 401 || status === 403
    ? 'Composio refused access. Check your project key and account authorization.'
    : status === 429 ? 'Composio is rate limiting requests. Try again later.'
      : 'The Composio request did not complete. Check the connection before retrying any write action.'), { code: 'composio/request-failed' })
}
const authUrl = value => {
  let url
  try { url = new URL(value) } catch { fail('The service did not return a sign-in address.') }
  if (url.protocol !== 'https:' || url.username || url.password
    || !(url.hostname === 'composio.dev' || url.hostname.endsWith('.composio.dev'))) fail('The sign-in address is not a trusted Composio address.')
  return url.href
}
const readTool = tool => tool.tags?.includes('readOnlyHint') === true
const accountRow = account => ({
  id: account.id, toolkit: account.toolkit?.slug, label: text(account.alias || account.toolkit?.slug || account.id),
  status: String(account.status ?? 'UNKNOWN'), disabled: account.isDisabled === true,
  authConfigId: account.authConfig?.id, updatedAt: account.updatedAt ?? null,
})

export function install(rt) {
  const pending = new Map(), flights = new Set()
  let client, clientKey, session, sessionIdentity, managed, managedBoot, configured = false, stopped = false
  let serviceEpoch = 0, lastSetup = null
  const catalogRows = new Map()
  let mutations = Promise.resolve()
  const settings = () => rt.state.composio ?? {}
  // Retain the wire field for older clients; saved read/ask modes no longer
  // gate execution. Account enablement and explicit Bot grants still apply.
  const policy = id => ({ enabled: true, bots: [], revision: 0, ...own(settings().policies, id), mode: 'auto' })
  const invalidate = (id) => {
    for (const flight of flights) if (!id || flight.accountId === id) flight.controller.abort()
    if (!id) {
      serviceEpoch++
      pending.clear(); client = null; clientKey = null; session = null; sessionIdentity = null
      void managed?.close().catch(() => {})
      managed = null; managedBoot = null; catalogRows.clear()
    }
  }
  const request = async (operation, parent, accountId, timeout = 30_000) => {
    if (stopped) fail('Connected apps are stopping.', 'stopped')
    const flight = { controller: new AbortController(), accountId }
    flights.add(flight)
    const signal = AbortSignal.any([flight.controller.signal, AbortSignal.timeout(timeout), ...(parent ? [parent] : [])])
    try { signal.throwIfAborted(); return await operation({ signal }) }
    catch (error) { throw safeError(error) }
    finally { flights.delete(flight) }
  }
  const sdk = async () => {
    await rt.loadSecrets()
    const key = rt.secretValue(KEY)
    if (!key) {
      if (!managedBoot) managedBoot = (async () => {
        const epoch = serviceEpoch
        const url = connectionServiceUrl(rt.config.connectedAppsService)
        const token = rt.secretValue(SERVICE_TOKEN)
        if (token && settings().serviceUrl !== url) fail('The saved connection belongs to a different connection service.')
        const service = createManagedApps({ url, token })
        managed = service
        if (!token) {
          if (rt.readOnly()) fail('This team is read-only.')
          const installation = await request(options => service.register(options.signal))
          if (stopped || epoch !== serviceEpoch) fail('The connected-app project changed.', 'changed')
          await rt.secretEndpoint('secret-set', { name: SERVICE_TOKEN, value: installation.token, scope: [], purpose: 'Connected-app installation access' })
          if (stopped || epoch !== serviceEpoch) fail('The connected-app project changed.', 'changed')
          rt.state.composio = { identity: randomUUID(), provider: 'managed', serviceUrl: url, installationId: installation.installationId,
            policies: {}, accounts: [], publicAccounts: [], lastUpdated: null }
          await rt.save()
        }
        return service
      })()
      const api = await managedBoot
      configured = true
      return api
    }
    configured = true
    if (!settings().identity) fail('Set up the connection service first.', 'not-configured')
    if (key !== clientKey) { invalidate(); client = makeClient(key); clientKey = key }
    return client
  }
  const router = async options => {
    const api = await sdk(), identity = settings().identity
    if (!session || sessionIdentity !== identity) {
      const next = await api.sessions.create(settings().userId, {
        manageConnections: true,
        multiAccount: { enable: true, maxAccountsPerToolkit: 5, requireExplicitSelection: true },
        authConfigs: settings().authConfigs ?? {},
      }, options)
      if (settings().identity !== identity) fail('The connected-app project changed. Start again.', 'changed')
      session = next; sessionIdentity = identity
    }
    return session
  }
  const view = () => ({
    configured, mode: settings().provider === 'managed' || !settings().identity ? 'managed' : 'project',
    lastSetup: lastSetup ? { ...lastSetup } : null,
    identity: settings().identity ?? null, userId: settings().userId ?? '', lastUpdated: settings().lastUpdated ?? null,
    accounts: (settings().accounts ?? []).map(account => ({ ...account, label: rt.redactSecrets(account.label), ...policy(account.id) })),
    pending: [...pending.values()].filter(item => item.expiresAt > Date.now()).map(({ id, toolkit, url, expiresAt }) => ({ id, toolkit, url, expiresAt })),
  })
  const fetchAccounts = async (api, options) => {
    if (api.kind === 'managed') return [...await api.accounts(options.signal), ...(settings().publicAccounts ?? [])]
    const rows = [], seen = new Set()
    let cursor
    for (let page = 0; page < 30; page++) {
      const response = await api.connectedAccounts.list({ userIds: [settings().userId], limit: 100, ...(cursor ? { cursor } : {}) }, options)
      for (const account of response.items ?? []) {
        if (validId(account.id) && SLUG.test(account.toolkit?.slug)) rows.push(accountRow(account))
      }
      const next = response.nextCursor
      if (!next) return [...rows, ...(settings().publicAccounts ?? [])]
      if (seen.has(next)) fail('Composio returned an invalid account page.')
      seen.add(next); cursor = next
    }
    fail('Too many accounts to list safely. Narrow the Composio user scope.')
  }
  const refresh = async signal => {
    const api = await sdk(), identity = settings().identity
    const accounts = await request(options => fetchAccounts(api, options), signal)
    if (identity !== settings().identity) fail('The connected-app project changed.', 'changed')
    for (const [id, attempt] of pending) {
      const account = accounts.find(item => item.toolkit === attempt.toolkit && (item.id === id
        || (attempt.managedLabel && item.label === attempt.managedLabel && !attempt.previousAccounts.includes(item.id))))
      if (account?.status === 'ACTIVE') {
        if (attempt.replaces) {
          const previous = policy(attempt.replaces)
          settings().policies[account.id] = { ...previous, bots: [...previous.bots], enabled: true, revision: (previous.revision ?? 0) + 1 }
          settings().policies[attempt.replaces] = { ...previous, enabled: false, bots: [], replacedBy: account.id, revision: (previous.revision ?? 0) + 1 }
          invalidate(attempt.replaces)
        }
        pending.delete(id)
      } else if (attempt.expiresAt <= Date.now()) pending.delete(id)
    }
    settings().accounts = accounts
    settings().lastUpdated = Date.now()
    await rt.save()
    return view()
  }
  const ownedAccount = async (id, signal) => {
    if (!validId(id)) fail('Choose a connected account.')
    const api = await sdk()
    const publicAccount = settings().publicAccounts?.find(account => account.id === id)
    if (publicAccount) return { api, account: publicAccount }
    const accounts = await request(options => fetchAccounts(api, options), signal, id)
    const account = accounts.find(item => item.id === id)
    if (!account) fail('This account does not belong to this Composio user.', 'account-unavailable')
    return { api, account }
  }
  const startLink = async (body, signal) => {
    for (const [id, attempt] of pending) if (attempt.expiresAt <= Date.now()) pending.delete(id)
    if (pending.size >= 20) fail('Finish or dismiss an existing sign-in before starting another.')
    const toolkit = text(body.toolkit, 80)
    if (!SLUG.test(toolkit)) fail('Choose an application.')
    const api = await sdk(), identity = settings().identity
    let previous
    if (body.replaces) {
      previous = (await ownedAccount(body.replaces, signal)).account
      if (previous.toolkit !== toolkit) fail('The replacement must use the same application.')
      if (policy(previous.id).replacedBy) fail('This account already has a replacement. Reconnect the new account instead.')
      for (const [id, attempt] of pending) if (attempt.replaces === previous.id) pending.delete(id)
    }
    const authConfigId = text(body.authConfigId || previous?.authConfigId, 128)
    if (api.kind === 'managed') {
      if (previous?.status === 'ACTIVE') fail('Disconnect this account before authorizing a replacement.')
      const before = await request(options => fetchAccounts(api, options), signal)
      if (!previous && before.some(account => account.toolkit === toolkit && account.status === 'ACTIVE')) {
        fail('This service requires one active account per app for tool execution.')
      }
      const label = text(body.label, 64) || `DS Bot ${randomUUID().slice(0, 8)}`
      const result = await request(options => api.authorize(toolkit, label, options.signal), signal)
      if (identity !== settings().identity) fail('The connected-app project changed.', 'changed')
      const attempt = { id: randomUUID(), toolkit, url: authUrl(result.url), expiresAt: Date.now() + 15 * 60_000,
        managedLabel: label, previousAccounts: before.map(account => account.id), ...(previous ? { replaces: previous.id } : {}) }
      pending.set(attempt.id, attempt)
      return { ...view(), authorization: { id: attempt.id, url: attempt.url, expiresAt: attempt.expiresAt } }
    }
    const result = await request(async options => {
      if (authConfigId) {
        if (!validId(authConfigId)) fail('Enter a valid auth configuration ID.')
        const auth = await api.authConfigs.get(authConfigId, options)
        if (auth.toolkit?.slug !== toolkit) fail('This auth configuration belongs to a different application.')
        return api.connectedAccounts.link(settings().userId, authConfigId, {
          allowMultiple: true, ...(text(body.label) ? { alias: text(body.label) } : {}),
        }, options)
      }
      return (await router(options)).authorize(toolkit, text(body.label) ? { alias: text(body.label) } : undefined, options)
    }, signal)
    if (identity !== settings().identity) fail('The connected-app project changed.', 'changed')
    if (!validId(result.id)) fail('The sign-in request has no valid account ID.')
    const attempt = { id: result.id, toolkit, url: authUrl(result.redirectUrl), expiresAt: Date.now() + 15 * 60_000,
      ...(previous ? { replaces: previous.id } : {}) }
    pending.set(result.id, attempt)
    return { ...view(), authorization: { id: attempt.id, url: attempt.url, expiresAt: attempt.expiresAt } }
  }
  const endpoints = {
    async 'composio-status'() {
      await rt.loadSecrets()
      configured = Boolean(rt.secretValue(KEY) || (settings().provider === 'managed' && rt.secretValue(SERVICE_TOKEN)))
      return view()
    },
    async 'composio-retry-service'(_body, signal) {
      invalidate()
      await request(() => sdk(), signal)
      return view()
    },
    async 'composio-configure'(body, signal) {
      await rt.loadSecrets()
      configured = Boolean(rt.secretValue(KEY))
      const key = text(body.apiKey, 4096)
      if (key.length < 8) fail('Enter your Composio project key.')
      if (configured && body.confirm !== true) fail('Confirm replacing this project. Existing Bot access will be reset.')
      const userId = text(body.userId, 128) || `dsbot-${randomUUID()}`
      if (!/^[a-zA-Z0-9_.:@-]{1,128}$/.test(userId)) fail('Use a simple user identifier without spaces.')
      let candidate, stage = 'verify'
      const at = Date.now()
      lastSetup = { state: 'running', stage, at }
      try {
        await request(async options => {
          try {
            candidate = makeClient(key)
            return await candidate.connectedAccounts.list({ userIds: [userId], limit: 1 }, options)
          } catch (error) {
            const status = responseStatus(error)
            throw Object.assign(new Error(status
              ? `Composio project-key verification failed (HTTP ${status}). The project configuration was not saved.`
              : 'Could not verify the project key with Composio. The project configuration was not saved.'),
            { code: 'composio/project-verification', ...(status ? { httpStatus: status } : {}) })
          }
        }, signal)
        stage = 'save'
        lastSetup = { state: 'running', stage, at }
        invalidate()
        await rt.secretEndpoint('secret-set', { name: KEY, value: key, scope: [], purpose: 'Composio project access for Connected apps' })
        rt.state.composio = { identity: randomUUID(), userId, policies: {}, authConfigs: {}, accounts: [], publicAccounts: [], lastUpdated: null }
        await rt.save()
        client = candidate; clientKey = key; configured = true
        lastSetup = { state: 'saved', stage, at }
        return view()
      } catch (error) {
        const message = stage === 'verify' ? error.message : 'Could not finish saving the project configuration on this gateway.'
        lastSetup = { state: 'failed', stage, at, message, ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) }
        rt.noteFailure?.({ source: 'api', where: 'composio-configure', code: `composio/project-${stage}`,
          status: error.httpStatus, text: message })
        if (stage === 'save') fail(message, 'project-save')
        throw error
      }
    },
    async 'composio-clear'(body) {
      if (body.confirm !== true) fail('Confirm removing this project from DS Bot.')
      invalidate()
      await rt.secretEndpoint('secret-delete', { name: KEY })
      if (rt.secretValue(SERVICE_TOKEN)) await rt.secretEndpoint('secret-delete', { name: SERVICE_TOKEN })
      delete rt.state.composio
      configured = false
      lastSetup = null
      await rt.save()
      return view()
    },
    async 'composio-catalog'(body, signal) {
      let api
      const options = { query: text(body.query), cursor: text(body.cursor, 1000) }
      const fallback = error => {
        if (stopped || signal?.aborted || error.code === 'composio/changed') throw error
        for (const item of CURATED_APPS) catalogRows.set(item.slug, item)
        return { ...appCatalogPage(CURATED_APPS, options), source: 'curated', available: false,
          pagination: { complete: false, reason: 'service-unavailable', items: CURATED_APPS.length }, warning: safeError(error).message }
      }
      try { api = await sdk() } catch (error) { return fallback(error) }
      if (api.kind === 'managed') {
        const identity = settings().identity
        let page
        try { page = await request(requestOptions => api.catalog(options, requestOptions.signal), signal) }
        catch (error) {
          if (settings().identity !== identity) fail('The connected-app project changed.', 'changed')
          return fallback(error)
        }
        if (settings().identity !== identity) fail('The connected-app project changed.', 'changed')
        for (const item of page.items) catalogRows.set(item.slug, item)
        return { ...page, items: page.items.map(item => ({ ...item,
          connected: (settings().accounts ?? []).some(account => account.toolkit === item.slug && account.status === 'ACTIVE') })) }
      }
      const response = await request(async options => (await router(options)).toolkits({
        limit: 40, ...(text(body.query) ? { search: text(body.query) } : {}),
        ...(text(body.cursor, 1000) ? { cursor: text(body.cursor, 1000) } : {}),
      }, options), signal)
      const items = response.items.map(item => ({ slug: item.slug, name: item.name, connected: item.connection?.isActive === true || settings().publicAccounts?.some(account => account.toolkit === item.slug),
        noAuth: item.isNoAuth === true }))
      for (const item of items) catalogRows.set(item.slug, item)
      return { items, cursor: response.cursor ?? null }
    },
    async 'composio-enable-public'(body, signal) {
      const toolkit = text(body.toolkit, 80)
      if (!SLUG.test(toolkit)) fail('Choose an application.')
      const api = await sdk()
      const response = api.kind === 'managed' ? null : await request(async options => (await router(options)).toolkits({ toolkits: [toolkit], limit: 10 }, options), signal)
      const found = api.kind === 'managed' ? (catalogRows.get(toolkit)?.noAuth ? catalogRows.get(toolkit) : null)
        : response.items.find(item => item.slug === toolkit && item.isNoAuth === true)
      if (!found) fail('This application requires account authorization.')
      settings().publicAccounts ??= []
      if (!settings().publicAccounts.some(account => account.toolkit === toolkit)) {
        settings().publicAccounts.push({ id: `public_${toolkit}`, toolkit, label: found.name, status: 'ACTIVE', disabled: false, public: true, updatedAt: Date.now() })
        await rt.save()
      }
      return refresh(signal)
    },
    'composio-refresh': (_body, signal) => refresh(signal),
    'composio-connect': startLink,
    async 'composio-cancel'(body) { pending.delete(text(body.id, 128)); return view() },
    async 'composio-disconnect'(body, signal) {
      if (body.confirm !== true) fail('Confirm disconnecting this account.')
      const { api, account } = await ownedAccount(body.id, signal)
      const previous = policy(account.id)
      settings().policies[account.id] = { ...previous, enabled: false, bots: [], revision: (previous.revision ?? 0) + 1 }
      invalidate(account.id)
      await rt.save()
      if (account.public) {
        settings().publicAccounts = settings().publicAccounts.filter(item => item.id !== account.id)
        await rt.save()
      } else await request(options => api.kind === 'managed' ? api.disconnect(account, options.signal)
        : api.connectedAccounts.delete(account.id, options), signal, account.id)
      pending.delete(account.id)
      return refresh(signal)
    },
    async 'composio-policy'(body, signal) {
      const { account } = await ownedAccount(body.id, signal)
      if (!Array.isArray(body.bots) || body.bots.some(id => !rt.botOf(id))) fail('Choose valid Bots.')
      const previous = policy(account.id)
      settings().policies[account.id] = { mode: 'auto', bots: [...new Set(body.bots)], enabled: body.enabled !== false,
        revision: (previous.revision ?? 0) + 1 }
      invalidate(account.id)
      await rt.save()
      await rt.connectorSettleRequests?.(`app:${account.toolkit}`)
      return view()
    },
  }
  const available = botId => (settings().accounts ?? []).filter(account => {
    const access = policy(account.id)
    return account.status === 'ACTIVE' && !account.disabled && access.enabled && !access.replacedBy && access.bots.includes(botId)
  })
  const caller = exec => {
    const bot = rt.botOf(rt.selfOf(exec.agent?.id))
    if (!bot) fail('Only a Bot in this team can use connected apps.')
    if (rt.readOnly()) fail('This team is read-only.')
    return bot
  }
  const authorizeAccount = (id, botId) => {
    const account = available(botId).find(item => item.id === id)
    if (!account) fail('This account is disconnected or not enabled for this Bot.', 'access-revoked')
    return account
  }
  const tools = [
    defineTool({
      name: 'connected_apps', description: 'List the external app accounts the user has enabled for this Bot. Use an exact account ID for tool search and execution.',
      parameters: {}, output,
      async execute(_args, exec) { await rt.load(); return rt.redactSecrets(JSON.stringify(available(caller(exec).id).map(account => ({ id: account.id, app: account.toolkit, name: account.label, permission: policy(account.id).mode })))) },
    }),
    defineTool({
      name: 'search_app_tools', description: 'Find actions in an enabled connected app. Returns the exact tool name, version and input schema. Search before executing.',
      parameters: { accountId: { type: 'string', required: true }, query: { type: 'string', required: true } }, output,
      async execute(args, exec) {
        await rt.load()
        const bot = caller(exec), account = authorizeAccount(args.accountId, bot.id), api = await sdk(), identity = settings().identity
        const tools = await request(options => api.kind === 'managed' ? api.search(account, text(args.query, 500), options.signal)
          : api.tools.getRawComposioTools({ toolkits: [account.toolkit],
          search: text(args.query, 500), limit: 10, important: false,
        }, undefined, options), exec.signal, account.id)
        authorizeAccount(account.id, bot.id)
        if (settings().identity !== identity) fail('The connected-app project changed.', 'changed')
        return rt.redactSecrets(JSON.stringify(tools.filter(tool => tool.toolkit?.slug === account.toolkit).map(tool => ({
          tool: tool.slug, version: tool.version, description: tool.description, readOnly: readTool(tool), input: tool.inputParameters,
        }))))
      },
    }),
    defineTool({
      name: 'execute_app_tool', description: 'Execute one previously discovered app action using the specified connected account. The user-enabled Bots can read and make changes automatically, including in scheduled tasks. A timeout has an unknown result: check the app before retrying.',
      parameters: { accountId: { type: 'string', required: true }, tool: { type: 'string', required: true },
        version: { type: 'string', required: true }, arguments: { type: 'object', additionalProperties: true, required: true } }, output,
      async execute(args, exec) {
        await rt.load()
        const bot = caller(exec), account = authorizeAccount(args.accountId, bot.id), api = await sdk()
        const identity = settings().identity, revision = policy(account.id).revision ?? 0
        if (!/^[A-Z0-9_]{1,160}$/.test(args.tool) || !text(args.version) || args.version === 'latest') fail('Use the exact tool name and version returned by search_app_tools.')
        if (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments) || JSON.stringify(args.arguments).length > 100_000) fail('Supply a bounded arguments object.')
        return request(async options => {
          const tool = api.kind === 'managed' ? api.tool(args.tool, args.version, account.id)
            : await api.tools.getRawComposioToolBySlug(args.tool, { version: args.version }, options)
          if (tool.toolkit?.slug !== account.toolkit) fail('This action belongs to another application.')
          const unchanged = () => {
            options.signal.throwIfAborted()
            authorizeAccount(account.id, bot.id)
            if (settings().identity !== identity || (policy(account.id).revision ?? 0) !== revision) fail('App permissions changed. Ask again before executing.', 'access-revoked')
          }
          unchanged()
          if (api.kind === 'managed') {
            const result = await api.execute(account, args.tool, args.version, args.arguments, options.signal, unchanged)
            const rendered = rt.redactSecrets(JSON.stringify(result))
            return rendered.length > 150000 ? rendered.slice(0, 150000) + '\n[Output truncated]' : rendered
          } else if (account.public) {
            if (tool.isNoAuth !== true) fail('This action requires an authenticated account.')
          } else {
            const current = await api.connectedAccounts.get(account.id, options)
            if (current.status !== 'ACTIVE' || current.isDisabled || current.toolkit?.slug !== account.toolkit) fail('Sign in to this account again before using it.', 'account-unavailable')
          }
          unchanged()
          const result = await api.tools.execute(tool.slug, { ...(!account.public ? { connectedAccountId: account.id } : {}), userId: settings().userId,
            version: tool.version ?? args.version, arguments: args.arguments, allowTracing: false }, options)
          const rendered = rt.redactSecrets(JSON.stringify(result))
          return rendered.length > 150000 ? rendered.slice(0, 150000) + '\n[Output truncated]' : rendered
        }, exec.signal, account.id, 180_000)
      },
    }),
  ]
  for (const tool of tools) rt.addTeamTool(tool)
  rt.ctx.effect(() => () => { stopped = true; invalidate(); for (const tool of tools) rt.removeTeamTool(tool.name) }, 'ds-bot: connected apps')
  Object.assign(rt, {
    composioView: view,
    extendedConnectorUsable: (botId, toolkit) => available(botId).some(account => account.toolkit === toolkit),
    extendedConnectorRows: () => [...new Map([
      ...(settings().accounts ?? []).map(account => [account.toolkit, { slug: account.toolkit, name: account.toolkit }]),
      ...catalogRows,
    ]).values()].map(item => ({
      id: `app:${item.slug}`, name: item.name, about: item.description ?? '', provider: 'apps',
      connected: (settings().accounts ?? []).some(account => account.toolkit === item.slug && account.status === 'ACTIVE'),
    })),
    async composioEndpoint(endpoint, body = {}, signal) {
      const handler = own(endpoints, endpoint)
      if (!handler) fail('Unknown connected-app operation.')
      const run = async () => {
        try {
          await rt.load()
          if (!['composio-status', 'composio-catalog'].includes(endpoint) && rt.readOnly()) fail('This team is read-only.')
          return await handler(body, signal)
        } catch (error) { throw safeError(error) }
      }
      if (['composio-status', 'composio-catalog'].includes(endpoint)) return run()
      const result = mutations.then(run, run)
      mutations = result.catch(() => {})
      return result
    },
  })
}
