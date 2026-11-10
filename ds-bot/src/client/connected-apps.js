import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { MaskedInput } from './secret-card.js'
import { reserveWindow } from './open-window.js'
import { t, hostText } from './i18n.js'
import { ConnectorMark } from './connectors.js'

export function ConnectedAppAccount({ account, bots, busy, save, reconnect, disconnect, managed }) {
  const [expanded, setExpanded] = useState(false)
  const controlsId = useId()
  const [selected, setSelected] = useState(account.bots ?? [])
  const [enabled, setEnabled] = useState(account.enabled)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    setSelected(account.bots ?? []); setEnabled(account.enabled)
  }, [account.id, account.revision])
  const toggle = id => setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id])
  const dirty = enabled !== account.enabled || JSON.stringify([...selected].sort()) !== JSON.stringify([...(account.bots ?? [])].sort())
  const active = account.status === 'ACTIVE' && !account.disabled && !account.replacedBy
  const access = bots.filter(bot => (account.bots ?? []).includes(bot.id)).map(bot => bot.name).join(', ')
  const status = account.replacedBy ? t('Replaced by a new connection') : active ? t('Connected') : t('Sign in again')
  return h('section', { className: 'bt-ca-account' },
    h('div', { className: 'bt-app bt-ca-account-row', 'data-state': active ? 'ready' : 'needs-sign-in' },
      h('button', { type: 'button', className: 'bt-app-main', 'aria-expanded': expanded, 'aria-controls': controlsId, onClick: () => setExpanded(!expanded) },
        h('span', { className: 'bt-app-icon', style: { width: 36, height: 36 } }, h(ConnectorMark, { connector: { id: account.toolkit, name: account.toolkit } })),
        h('span', { className: 'bt-app-text' }, h('span', { className: 'bt-app-name' }, account.label),
          h('span', { className: 'bt-app-status' }, status, ' · ', account.enabled === false ? t('Disabled') : access || t('No Bot access'), dirty ? ` · ${t('Unsaved changes')}` : ''))),
      h('button', { type: 'button', className: 'bt-app-btn', 'aria-expanded': expanded, 'aria-controls': controlsId, onClick: () => setExpanded(!expanded) }, t(expanded ? 'Close details' : 'Manage'))),
    expanded ? h('div', { id: controlsId, className: 'bt-ca-account-details' },
      h('div', { className: 'bt-ca-policy' },
        h('label', null, h('input', { type: 'checkbox', checked: enabled, disabled: busy || Boolean(account.replacedBy), onChange: e => setEnabled(e.target.checked) }), t('Enable account'))),
      h('fieldset', { className: 'bt-ca-bots', disabled: busy || Boolean(account.replacedBy) },
        h('legend', null, t('Bots allowed to use this account')),
        bots.length ? bots.map(bot => h('label', { key: bot.id },
          h('input', { type: 'checkbox', checked: selected.includes(bot.id), onChange: () => toggle(bot.id) }), bot.name))
          : h('span', { className: 'bt-set-hint' }, t('Create a Bot before granting access.'))),
      selected.length === 0 ? h('p', { className: 'bt-set-hint' }, t('No Bot has access until you select one and save.')) : null,
      dirty ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => save({ id: account.id, bots: selected, enabled }) }, t('Save access')) : null,
      h('div', { className: 'bt-ca-buttons' },
        !account.public && (!managed || !active) ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => reconnect(account) }, t('Reconnect')) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setConfirm(!confirm) }, t('Disconnect'))),
      confirm ? h('div', { className: 'bt-ca-confirm' },
        h('span', null, t('Disconnect this account and remove its Bot access?')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => disconnect(account.id) }, t('Confirm disconnect')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirm(false) }, t('Cancel'))) : null,
      h('div', { className: 'bt-ca-id' }, t('Account ID'), ': ', h('code', null, account.id))) : null)
}

// One waiting authorization. The address is a real link, so it can always be opened
// even when the reserved sign-in window was blocked or the panel unmounted mid-request.
function PendingAttempt({ attempt, busy, cancel }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500) }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(attempt.url).then(done, () => {})
  }
  return h('div', { className: 'bt-ca-pending', role: 'status' },
    h('span', null, t('Waiting for {app} authorization', { app: attempt.toolkit })),
    h('a', { className: 'bt-soft bt-soft-sm', href: attempt.url, target: '_blank', rel: 'noopener noreferrer' }, t('Open sign-in')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: copy }, t(copied ? 'Copied' : 'Copy link')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => cancel(attempt.id) }, t('Dismiss')))
}

export function ConnectedAppsPanel({ actions, bots = [], embedded = false, configuration = false, accountsOnly = false, searchQuery = '', initialQuery = '', exclude = [] }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [apiKey, setApiKey] = useState(''), [userId, setUserId] = useState('')
  const [confirmProject, setConfirmProject] = useState(false), [removeProject, setRemoveProject] = useState(false)
  const [query, setQuery] = useState(initialQuery), [catalog, setCatalog] = useState({ items: [], cursor: null }), [loading, setLoading] = useState(true)
  const [selectedApp, setSelectedApp] = useState(null), [label, setLabel] = useState(''), [authConfigId, setAuthConfigId] = useState('')
  const mounted = useRef(true), searchEpoch = useRef(0), actionEpoch = useRef(0), operation = useRef(false), pendingWindow = useRef(null)
  const call = (endpoint, body) => actions.connectedApps(endpoint, body)
  const update = value => {
    if (!mounted.current) return
    setData(value)
    if (Array.isArray(value.accounts)) setCatalog(previous => ({ ...previous, items: previous.items.map(app => ({
      ...app, connected: value.accounts.some(account => account.toolkit === app.slug && account.status === 'ACTIVE'),
    })) }))
  }
  const message = failure => { if (mounted.current) setError(failure?.message ?? t('Could not load connected apps.')) }
  useEffect(() => {
    mounted.current = true
    const epoch = actionEpoch.current
    void call('status').then(value => {
      if (epoch !== actionEpoch.current) return
      update(value); if (mounted.current) setUserId(value.userId ?? '')
    }, failure => { if (epoch === actionEpoch.current) message(failure) })
    return () => { mounted.current = false; searchEpoch.current++; pendingWindow.current?.close(); pendingWindow.current = null }
  }, [])
  const refresh = () => {
    const epoch = actionEpoch.current
    return call('refresh').then(value => { if (epoch === actionEpoch.current) update(value) },
      failure => { if (epoch === actionEpoch.current) message(failure) })
  }
  useEffect(() => { if (data?.configured && !operation.current) void refresh() }, [data?.configured, data?.identity])
  useEffect(() => {
    if (!data?.configured) return
    const timer = setInterval(() => { if (!operation.current) void refresh() }, data.pending?.length ? 5000 : 60000)
    return () => clearInterval(timer)
  }, [data?.configured, data?.pending?.length])
  const searchText = embedded ? searchQuery : query
  const search = (cursor) => {
    const epoch = ++searchEpoch.current
    setLoading(true); setError('')
    void call('catalog', { query: searchText, ...(cursor ? { cursor } : {}) }).then(async page => {
      if (!mounted.current || epoch !== searchEpoch.current) return
      setCatalog(previous => ({ ...page, items: cursor ? [...previous.items, ...page.items.filter(item => !previous.items.some(old => old.slug === item.slug))] : page.items }))
      setError(page.warning ?? '')
      if (!data?.configured) {
        const status = await call('status')
        if (mounted.current && epoch === searchEpoch.current) update(status)
      }
    }).catch(failure => { if (mounted.current && epoch === searchEpoch.current) message(failure) }).finally(() => { if (mounted.current && epoch === searchEpoch.current) setLoading(false) })
  }
  useEffect(() => {
    searchEpoch.current++
    if (!data || configuration || accountsOnly) return
    setLoading(true)
    const timer = setTimeout(() => search(), 300)
    return () => { clearTimeout(timer); searchEpoch.current++ }
  }, [searchText, data?.identity, configuration, accountsOnly])
  const run = async (endpoint, payload, done) => {
    if (operation.current) return
    actionEpoch.current++
    operation.current = true; setBusy(true); setError('')
    try {
      const result = await call(endpoint, payload)
      update(result); if (mounted.current) done?.(result)
      return result
    } catch (failure) {
      message(failure)
      if (endpoint === 'configure') {
        try { update(await call('status')) } catch {}
      }
    }
    finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const connect = (app, replaces) => {
    if (operation.current) return
    const browser = reserveWindow()
    pendingWindow.current = browser
    void run('connect', { toolkit: app.slug ?? app.toolkit, label: replaces ? app.label : label,
      ...(replaces ? { replaces: app.id } : {}), ...(authConfigId && !replaces ? { authConfigId } : {}),
    }, () => { setSelectedApp(null); setLabel(''); setAuthConfigId('') })
      .then(result => {
        // Address the sign-in page even if this panel unmounted while the request ran:
        // a skipped navigation would leave the reserved window stuck on about:blank.
        const url = result?.authorization?.url
        if (url && browser.go(url)) return
        browser.close()
        if (mounted.current && result && !url) setError(t('The sign-in page could not open automatically. Use the sign-in link below.'))
      })
      .finally(() => { pendingWindow.current = null })
  }
  const chooseApp = app => {
    if (app.noAuth) { void run('enable-public', { toolkit: app.slug }); return }
    setSelectedApp(app); setLabel(''); setAuthConfigId('')
  }
  const setupError = !data?.configured && data?.lastSetup?.state === 'failed' ? data.lastSetup.message : ''
  const shownError = setupError || error
  return h('div', { className: 'bt-ca' },
    shownError ? h('div', { className: 'bt-connector-error', role: 'alert' }, hostText(shownError)) : null,
    !data ? h('p', { role: 'status' }, t('Loading connected apps…')) : null,
    configuration ? h('details', { className: 'bt-ca-project', open: true },
      h('summary', null, t('Use your own connection project'), data?.mode === 'project' ? ` · ${t('Configured')}` : ''),
      h('p', { className: 'bt-set-hint', role: 'status' }, t(data?.mode === 'project' && data?.configured
        ? 'A project key is saved on this gateway.' : 'No project key is saved on this gateway. Click Save project after entering the key.')),
      h('p', { className: 'bt-set-hint' }, t('Use your own Composio project to connect app accounts. Your key stays on this computer.')),
      h('label', { className: 'bt-q-field bt-secret-field' }, t('Project API key'),
        h(MaskedInput, { value: apiKey, onChange: setApiKey, label: t('Project API key'), disabled: busy })),
      h('label', { className: 'bt-q-field' }, t('Composio user ID'),
        h('input', { className: 'bt-input', value: userId, disabled: busy, placeholder: t('Create an ID automatically'), autoComplete: 'off', onChange: e => setUserId(e.target.value) })),
      data?.configured ? h('label', { className: 'bt-ca-check' },
        h('input', { type: 'checkbox', checked: confirmProject, onChange: e => setConfirmProject(e.target.checked) }),
        t('Replacing the project resets account access for all Bots.')) : null,
      h('div', { className: 'bt-ca-buttons' },
        h('button', { type: 'button', className: 'bt-soft', disabled: busy || !apiKey.trim() || (data?.configured && !confirmProject),
          onClick: () => void run('configure', { apiKey, userId, confirm: confirmProject }, value => { setApiKey(''); setUserId(value.userId); setConfirmProject(false) }) }, t(busy ? 'Verifying and saving…' : 'Save project')),
        data?.configured ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => setRemoveProject(!removeProject) }, t('Remove project')) : null),
      removeProject ? h('div', { className: 'bt-ca-confirm' }, h('p', null, t('Remove the project key and all Bot grants from this computer? Accounts remain in Composio.')),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => void run('clear', { confirm: true }, () => { setRemoveProject(false); setApiKey(''); setUserId('') }) }, t('Confirm removal'))) : null) : null,
    !configuration && error ? h('div', { className: 'bt-ca-buttons' },
      h('span', { className: 'bt-set-hint' }, t('Extended connectors are unavailable. Your existing connectors remain available.')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || loading,
        onClick: () => void run('retry-service', {}, () => search()) }, t('Try again'))) : null,
    !configuration && data?.configured && ((data.accounts?.length ?? 0) > 0 || (data.pending?.length ?? 0) > 0) ? h('section', null,
      h('div', { className: 'bt-ca-heading' }, h('h3', null, t('Connected accounts')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run('refresh') }, t('Refresh accounts'))),
      Number.isFinite(data.lastUpdated) ? h('p', { className: 'bt-set-hint' }, t('Last checked: {time}', { time: new Date(data.lastUpdated).toLocaleString() })) : null,
      data.pending?.map(attempt => h(PendingAttempt, { key: attempt.id, attempt, busy, cancel: id => void run('cancel', { id }) })),
      data.accounts.length ? data.accounts.map(account => h(ConnectedAppAccount, { key: account.id, account, bots, busy, managed: data.mode === 'managed',
        save: payload => void run('policy', payload), reconnect: item => connect(item, true),
        disconnect: id => void run('disconnect', { id, confirm: true }),
      })) : h('p', { className: 'bt-set-hint' }, t('No connected accounts. Choose an app below to sign in.'))) : null,
    !configuration && !accountsOnly && (loading || catalog.source || catalog.items.length > 0 || !error) ? h('section', null,
      h('h3', null, t('App library')),
      catalog.source === 'curated' ? h('p', { className: 'bt-set-hint', role: 'status' },
        t('Showing the built-in app catalog. Sign-in is unavailable until the connection service responds.')) : null,
      !embedded ? h('input', { type: 'search', className: 'bt-input', value: query, 'aria-label': t('Search app library'),
        placeholder: t('Search app library'), onChange: e => setQuery(e.target.value) }) : null,
      loading ? h('p', { role: 'status', className: 'bt-set-hint' }, t('Loading apps…')) : null,
      !loading && data && catalog.items.length === 0 ? h('p', { className: 'bt-set-hint' }, t('No matching apps.')) : null,
      !selectedApp ? h('div', { className: 'bt-app-grid bt-ca-library' }, catalog.items.filter(app => !exclude.includes(app.slug)).map(app => h('div', { key: app.slug, className: 'bt-app' },
        h('button', { type: 'button', className: 'bt-app-main', disabled: busy || catalog.available === false || (app.connected && (app.noAuth || data?.mode === 'managed')), onClick: () => chooseApp(app) },
          h('span', { className: 'bt-app-icon', style: { width: 36, height: 36 } }, h(ConnectorMark, { connector: { id: app.slug, name: app.name } })),
          h('span', { className: 'bt-app-text' }, h('span', { className: 'bt-app-name' }, app.slug === 'composio' ? t('Composio API tools') : app.name),
            app.slug === 'composio' ? h('span', { className: 'bt-app-status' }, t('Platform tools, separate from connection settings')) : null)),
        h('button', { type: 'button', className: 'bt-app-btn', disabled: busy || catalog.available === false || (app.connected && (app.noAuth || data?.mode === 'managed')), onClick: () => chooseApp(app) },
          app.noAuth ? app.connected ? t('Enabled') : t('Enable app') : app.connected ? data?.mode === 'managed' ? t('Connected') : t('Add account') : t('Connect'))))) : null,
      !selectedApp && catalog.cursor ? h('button', { type: 'button', className: 'bt-soft', disabled: loading, onClick: () => search(catalog.cursor) }, t('Load more apps')) : null,
      selectedApp ? h('div', { className: 'bt-ca-connect' },
        h('h3', null, t('Connect {app}', { app: selectedApp.name })),
        h('label', { className: 'bt-q-field' }, t('Account label (optional)'), h('input', { className: 'bt-input', value: label, maxLength: 200, onChange: e => setLabel(e.target.value) })),
        data?.mode === 'project' ? h('label', { className: 'bt-q-field' }, t('Auth config ID (optional)'), h('input', { className: 'bt-input', value: authConfigId, onChange: e => setAuthConfigId(e.target.value) })) : null,
        data?.mode === 'project' ? h('p', { className: 'bt-set-hint' }, t('Most apps use Composio sign-in. Supply an auth config ID only when your project requires a custom configuration.')) : null,
        h('div', { className: 'bt-ca-buttons' },
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => connect(selectedApp) }, t(busy ? 'Opening sign-in…' : 'Continue to sign-in')),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => setSelectedApp(null) }, t('Cancel')))) : null) : null)
}

export const CONNECTED_APPS_CSS = `
.bt-ca{display:flex;flex-direction:column;gap:20px;min-width:0;container-type:inline-size}
.bt-ca h3{font-size:13px;line-height:18px;font-weight:600;margin:0 0 12px}.bt-ca p{margin:6px 0 12px}
.bt-ca-project{padding:14px 16px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-ca-project summary{font-weight:500;cursor:pointer}.bt-ca-project[open] summary{margin-bottom:12px}
.bt-ca .bt-q-field{display:flex;flex-direction:column;gap:6px;margin:12px 0;min-width:0}
.bt-ca-heading{display:flex;align-items:start;justify-content:space-between;gap:12px}
.bt-ca-heading p{font-size:12px;color:var(--bt-ink-2);margin:4px 0}
.bt-ca-buttons,.bt-ca-confirm,.bt-ca-pending{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.bt-ca-confirm,.bt-ca-pending{padding:12px 0}.bt-ca-confirm{color:var(--bt-ink-2)}
.bt-ca-account{border-bottom:1px solid var(--bt-line);min-width:0}.bt-ca-account-row{min-height:64px}.bt-ca-account-details{padding:12px 16px 16px;background:var(--bt-card);border-radius:12px;margin-bottom:12px;display:flex;flex-direction:column;gap:12px}.bt-ca-account .bt-app-status{max-width:100%}
.bt-ca-id{display:block;font-size:11px;color:var(--bt-ink-3);overflow-wrap:anywhere;margin:6px 0 12px}
.bt-ca-policy{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.bt-ca-policy label,.bt-ca-check{display:flex;align-items:center;gap:8px}
.bt-ca-bots{border:0;margin:0;padding:8px 0;display:flex;flex-wrap:wrap;gap:12px}
.bt-ca-bots legend{font-size:12px;color:var(--bt-ink-2);padding:8px 0}
.bt-ca-bots label{display:flex;align-items:center;gap:6px}.bt-ca input[type=checkbox]{accent-color:var(--bt-accent)}
.bt-ca-library{margin:12px 0}.bt-ca > section{min-width:0}.bt-ca > section > .bt-input{width:100%;box-sizing:border-box}.bt-ca .bt-ca-heading{align-items:center}.bt-ca .bt-ca-heading h3{margin:0}.bt-ca .bt-ca-id{margin:0;color:var(--bt-ink-3)}
.bt-ca-connect{padding:16px;border:1px solid var(--bt-line);border-radius:12px;margin-top:16px}
.bt-ca-pending a.bt-soft{display:inline-flex;align-items:center;text-decoration:none}
@media(max-width:560px){.bt-ca-heading{flex-wrap:wrap}.bt-ca-policy{align-items:stretch;flex-direction:column}.bt-ca button{min-height:40px}.bt-ca input,.bt-ca select{font-size:16px}}
`
