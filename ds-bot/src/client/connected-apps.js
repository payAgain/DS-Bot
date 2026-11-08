import { createElement as h, useEffect, useRef, useState } from 'react'
import { MaskedInput } from './secret-card.js'
import { reserveWindow, openPage } from './open-window.js'
import { t, hostText } from './i18n.js'

function Account({ account, bots, busy, save, reconnect, disconnect }) {
  const [mode, setMode] = useState(account.mode)
  const [selected, setSelected] = useState(account.bots ?? [])
  const [enabled, setEnabled] = useState(account.enabled)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    setMode(account.mode); setSelected(account.bots ?? []); setEnabled(account.enabled)
  }, [account.id, account.revision])
  const toggle = id => setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id])
  const dirty = mode !== account.mode || enabled !== account.enabled || JSON.stringify([...selected].sort()) !== JSON.stringify([...(account.bots ?? [])].sort())
  const active = account.status === 'ACTIVE' && !account.disabled && !account.replacedBy
  return h('section', { className: 'bt-ca-account' },
    h('div', { className: 'bt-ca-heading' },
      h('div', null, h('strong', null, account.label), h('p', null, account.toolkit, ' · ',
        account.replacedBy ? t('Replaced by a new connection') : active ? t('Connected') : t('Sign in again'))),
      h('div', { className: 'bt-ca-buttons' },
        !account.public ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => reconnect(account) }, t('Reconnect')) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setConfirm(!confirm) }, t('Disconnect')))),
    h('code', { className: 'bt-ca-id' }, account.id),
    confirm ? h('div', { className: 'bt-ca-confirm' },
      h('span', null, t('Disconnect this account and remove its Bot access?')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => disconnect(account.id) }, t('Confirm disconnect')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirm(false) }, t('Cancel'))) : null,
    h('div', { className: 'bt-ca-policy' },
      h('label', null, h('input', { type: 'checkbox', checked: enabled, disabled: busy || Boolean(account.replacedBy), onChange: e => setEnabled(e.target.checked) }), t('Enable account')),
      h('label', null, t('Permission'), h('select', { className: 'bt-input', value: mode, disabled: busy, onChange: e => setMode(e.target.value) },
        h('option', { value: 'read' }, t('Read only')),
        h('option', { value: 'ask' }, t('Ask before changes'))))),
    h('fieldset', { className: 'bt-ca-bots', disabled: busy || Boolean(account.replacedBy) },
      h('legend', null, t('Bots allowed to use this account')),
      bots.length ? bots.map(bot => h('label', { key: bot.id },
        h('input', { type: 'checkbox', checked: selected.includes(bot.id), onChange: () => toggle(bot.id) }), bot.name))
        : h('span', { className: 'bt-set-hint' }, t('Create a Bot before granting access.'))),
    selected.length === 0 ? h('p', { className: 'bt-set-hint' }, t('No Bot has access until you select one and save.')) : null,
    dirty ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => save({ id: account.id, mode, bots: selected, enabled }) }, t('Save access')) : null)
}

export function ConnectedAppsPanel({ actions, bots = [] }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [apiKey, setApiKey] = useState(''), [userId, setUserId] = useState('')
  const [confirmProject, setConfirmProject] = useState(false), [removeProject, setRemoveProject] = useState(false)
  const [query, setQuery] = useState(''), [catalog, setCatalog] = useState({ items: [], cursor: null }), [loading, setLoading] = useState(false)
  const [selectedApp, setSelectedApp] = useState(null), [label, setLabel] = useState(''), [authConfigId, setAuthConfigId] = useState('')
  const mounted = useRef(true), searchEpoch = useRef(0), actionEpoch = useRef(0), operation = useRef(false)
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
    return () => { mounted.current = false; searchEpoch.current++ }
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
  const search = (cursor) => {
    const epoch = ++searchEpoch.current
    setLoading(true)
    void call('catalog', { query, ...(cursor ? { cursor } : {}) }).then(page => {
      if (!mounted.current || epoch !== searchEpoch.current) return
      setCatalog(previous => ({ items: cursor ? [...previous.items, ...page.items.filter(item => !previous.items.some(old => old.slug === item.slug))] : page.items, cursor: page.cursor }))
    }, failure => { if (mounted.current && epoch === searchEpoch.current) message(failure) }).finally(() => { if (mounted.current && epoch === searchEpoch.current) setLoading(false) })
  }
  useEffect(() => {
    searchEpoch.current++
    if (!data?.configured) { setCatalog({ items: [], cursor: null }); return }
    const timer = setTimeout(() => search(), 300)
    return () => { clearTimeout(timer); searchEpoch.current++ }
  }, [query, data?.configured, data?.identity])
  const run = async (endpoint, payload, done) => {
    if (operation.current) return
    actionEpoch.current++
    operation.current = true; setBusy(true); setError('')
    try {
      const result = await call(endpoint, payload)
      update(result); if (mounted.current) done?.(result)
      return result
    } catch (failure) { message(failure) }
    finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const connect = (app, replaces) => {
    if (operation.current) return
    const browser = reserveWindow()
    void run('connect', { toolkit: app.slug ?? app.toolkit, label: replaces ? app.label : label,
      ...(replaces ? { replaces: app.id } : {}), ...(authConfigId && !replaces ? { authConfigId } : {}),
    }, result => { browser.go(result.authorization.url); setSelectedApp(null); setLabel(''); setAuthConfigId('') })
      .then(result => { if (!result) browser.close() })
  }
  return h('div', { className: 'bt-ca' },
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, hostText(error)) : null,
    !data ? h('p', { role: 'status' }, t('Loading connected apps…')) : null,
    h('details', { className: 'bt-ca-project', open: !data?.configured || undefined },
      h('summary', null, t('Composio project'), data?.configured ? ` · ${t('Configured')}` : ''),
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
          onClick: () => void run('configure', { apiKey, userId, confirm: confirmProject }, value => { setApiKey(''); setUserId(value.userId); setConfirmProject(false) }) }, t('Save project')),
        data?.configured ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => setRemoveProject(!removeProject) }, t('Remove project')) : null),
      removeProject ? h('div', { className: 'bt-ca-confirm' }, h('p', null, t('Remove the project key and all Bot grants from this computer? Accounts remain in Composio.')),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => void run('clear', { confirm: true }, () => { setRemoveProject(false); setApiKey(''); setUserId('') }) }, t('Confirm removal'))) : null),
    data?.configured ? h('section', null,
      h('div', { className: 'bt-ca-heading' }, h('h3', null, t('Connected accounts')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run('refresh') }, t('Refresh accounts'))),
      Number.isFinite(data.lastUpdated) ? h('p', { className: 'bt-set-hint' }, t('Last checked: {time}', { time: new Date(data.lastUpdated).toLocaleString() })) : null,
      data.pending?.map(attempt => h('div', { key: attempt.id, className: 'bt-ca-pending', role: 'status' },
        h('span', null, t('Waiting for {app} authorization', { app: attempt.toolkit })),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => openPage(attempt.url) }, t('Open sign-in')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run('cancel', { id: attempt.id }) }, t('Dismiss')))),
      data.accounts.length ? data.accounts.map(account => h(Account, { key: account.id, account, bots, busy,
        save: payload => void run('policy', payload), reconnect: item => connect(item, true),
        disconnect: id => void run('disconnect', { id, confirm: true }),
      })) : h('p', { className: 'bt-set-hint' }, t('No connected accounts. Choose an app below to sign in.'))) : null,
    data?.configured ? h('section', null,
      h('h3', null, t('App library')),
      h('input', { type: 'search', className: 'bt-input', value: query, 'aria-label': t('Search app library'),
        placeholder: t('Search app library'), onChange: e => setQuery(e.target.value) }),
      loading ? h('p', { role: 'status', className: 'bt-set-hint' }, t('Loading apps…')) : null,
      !loading && catalog.items.length === 0 ? h('p', { className: 'bt-set-hint' }, t('No matching apps.')) : null,
      h('div', { className: 'bt-ca-library' }, catalog.items.map(app => h('div', { key: app.slug, className: 'bt-ca-app' },
        h('div', null, h('strong', null, app.name), h('span', { className: 'bt-set-hint' }, app.slug)),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || (app.noAuth && app.connected), onClick: () => {
          if (app.noAuth) { void run('enable-public', { toolkit: app.slug }); return }
          setSelectedApp(app); setLabel(''); setAuthConfigId('')
        } }, app.noAuth ? app.connected ? t('Enabled') : t('Enable app') : app.connected ? t('Add account') : t('Connect'))))),
      catalog.cursor ? h('button', { type: 'button', className: 'bt-soft', disabled: loading, onClick: () => search(catalog.cursor) }, t('Load more apps')) : null,
      selectedApp ? h('div', { className: 'bt-ca-connect' },
        h('h3', null, t('Connect {app}', { app: selectedApp.name })),
        h('label', { className: 'bt-q-field' }, t('Account label (optional)'), h('input', { className: 'bt-input', value: label, maxLength: 200, onChange: e => setLabel(e.target.value) })),
        h('label', { className: 'bt-q-field' }, t('Auth config ID (optional)'), h('input', { className: 'bt-input', value: authConfigId, onChange: e => setAuthConfigId(e.target.value) })),
        h('p', { className: 'bt-set-hint' }, t('Most apps use Composio sign-in. Supply an auth config ID only when your project requires a custom configuration.')),
        h('div', { className: 'bt-ca-buttons' },
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => connect(selectedApp) }, t('Continue to sign-in')),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => setSelectedApp(null) }, t('Cancel')))) : null) : null)
}

export const CONNECTED_APPS_CSS = `
.bt-ca{display:flex;flex-direction:column;gap:24px;min-width:0}
.bt-ca h3{font-size:14px;font-weight:600;margin:0 0 12px}.bt-ca p{margin:6px 0 12px}
.bt-ca-project{padding:14px 16px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-ca-project summary{font-weight:500;cursor:pointer}.bt-ca-project[open] summary{margin-bottom:12px}
.bt-ca .bt-q-field{display:flex;flex-direction:column;gap:6px;margin:12px 0;min-width:0}
.bt-ca-heading{display:flex;align-items:start;justify-content:space-between;gap:12px}
.bt-ca-heading p{font-size:12px;color:var(--bt-ink-2);margin:4px 0}
.bt-ca-buttons,.bt-ca-confirm,.bt-ca-pending{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.bt-ca-confirm,.bt-ca-pending{padding:12px 0}.bt-ca-confirm{color:var(--bt-ink-2)}
.bt-ca-account{padding:16px 0;border-top:1px solid var(--bt-line)}
.bt-ca-id{display:block;font-size:11px;color:var(--bt-ink-3);overflow-wrap:anywhere;margin:6px 0 12px}
.bt-ca-policy{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.bt-ca-policy label,.bt-ca-check{display:flex;align-items:center;gap:8px}
.bt-ca-bots{border:0;padding:10px 0;display:flex;flex-wrap:wrap;gap:12px}
.bt-ca-bots legend{font-size:12px;color:var(--bt-ink-2);padding:8px 0}
.bt-ca-bots label{display:flex;align-items:center;gap:6px}.bt-ca input[type=checkbox]{accent-color:var(--bt-accent)}
.bt-ca-library{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:0 20px;margin:12px 0}
.bt-ca-app{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--bt-line)}
.bt-ca-app>div{display:flex;flex-direction:column;gap:4px;min-width:0}.bt-ca-app strong{font-size:13px;overflow-wrap:anywhere}
.bt-ca-connect{padding:16px;border:1px solid var(--bt-line);border-radius:12px;margin-top:16px}
@media(max-width:560px){.bt-ca-heading{flex-wrap:wrap}.bt-ca-policy{align-items:stretch;flex-direction:column}.bt-ca button{min-height:40px}.bt-ca input,.bt-ca select{font-size:16px}}
`
