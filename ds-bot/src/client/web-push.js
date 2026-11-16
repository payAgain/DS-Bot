import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

const API = '/api/bot/web-push'
const WORKER = '/api/bot/web-push-worker.js'
const MANIFEST = '/api/bot/web-push-manifest.json'
const LOCAL = 'ds-bot:web-push-owned'
let configuration, reading, manifestConflict = false
export const webPushEnabled = () => {
  try { return localStorage.getItem(LOCAL) === '1' } catch { return false }
}
const noteOwned = value => { try { localStorage.setItem(LOCAL, value ? '1' : '0') } catch {} }
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
export function pushSupport(env = globalThis) {
  const nav = env.navigator ?? {}
  const ios = /iP(hone|ad|od)/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  const standalone = nav.standalone === true || env.matchMedia?.('(display-mode: standalone)')?.matches === true
  return { ios, standalone, supported: env.isSecureContext === true && Boolean(nav.serviceWorker && env.PushManager && env.Notification), permission: env.Notification?.permission ?? 'unsupported' }
}
function readConfiguration() {
  if (reading) return reading
  reading = (async () => {
    const response = await fetch(API, { credentials: 'same-origin', cache: 'no-store' })
    const value = await response.json()
    if (!response.ok || !value.ok) throw new Error('push/unavailable')
    configuration = value
    noteOwned(value.subscribed)
    return value
  })().finally(() => { reading = null })
  return reading
}
async function change(action, values = {}) {
  if (!configuration?.csrf) throw new Error('push/unavailable')
  const response = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsbot-push-csrf': configuration.csrf }, body: JSON.stringify({ action, ...values }) })
  const value = await response.json()
  if (!response.ok || !value.ok) throw new Error(value.code ?? 'push/unavailable')
  return value
}
const ownWorker = worker => {
  try { const url = new URL(worker?.scriptURL); return url.origin === location.origin && url.pathname === WORKER } catch { return false }
}
export async function ownedRegistration(serviceWorker = navigator.serviceWorker) {
  const registrations = await serviceWorker.getRegistrations()
  const root = registrations.find(entry => entry.scope === new URL('/', location.origin).href)
  if (root && ![root.active, root.waiting, root.installing].some(ownWorker)) throw new Error('push/worker-conflict')
  return root
}
export async function preparePushWorker() {
  await ownedRegistration()
  const registration = await navigator.serviceWorker.register(WORKER, { scope: '/', updateViaCache: 'none' })
  if (registration.active) return registration
  const worker = registration.installing ?? registration.waiting
  if (!worker) throw new Error('push/unavailable')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error('push/unavailable')) }, 12000)
    const changed = () => {
      if (!['activated', 'redundant'].includes(worker.state)) return
      clearTimeout(timer); worker.removeEventListener('statechange', changed)
      if (worker.state === 'activated') resolve()
      else reject(new Error('push/unavailable'))
    }
    worker.addEventListener('statechange', changed)
    changed()
  })
  return registration
}
function publicKey(value) {
  const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
  return Uint8Array.from(bytes, char => char.charCodeAt(0))
}

export function installPushEntry({ roster, actions, document: doc = globalThis.document, location: loc = globalThis.location, history: hist = globalThis.history }) {
  if (!doc || !loc?.href || !hist) return () => {}
  const url = new URL(loc.href), undo = []
  manifestConflict = false
  if (url.searchParams.get('dsbot-pwa') === '1') {
    const existing = doc.querySelector('link[rel="manifest"]')
    const path = existing ? new URL(existing.href, loc.href).pathname : undefined
    if (existing && path !== '/manifest.webmanifest' && path !== MANIFEST) manifestConflict = true
    else {
      const manifest = existing ?? doc.createElement('link')
      const previous = { href: manifest.getAttribute('href'), crossOrigin: manifest.getAttribute('crossorigin') }
      manifest.rel = 'manifest'; manifest.href = MANIFEST; manifest.crossOrigin = 'use-credentials'
      if (!existing) doc.head.appendChild(manifest)
      undo.push(() => {
        if (!existing) manifest.remove()
        else { manifest.setAttribute('href', previous.href); if (previous.crossOrigin === null) manifest.removeAttribute('crossorigin'); else manifest.setAttribute('crossorigin', previous.crossOrigin) }
      })
      const icon = doc.createElement('link'); icon.rel = 'apple-touch-icon'; icon.href = `${API}-icon-192.png`; doc.head.prepend(icon); undo.push(() => icon.remove())
    }
  }
  const navigate = () => {
    const snapshot = roster.getSnapshot()
    if (!snapshot.ready) return
    const target = url.searchParams.get('dsbot-push')
    if (validId(target) && (snapshot.byId?.[target] || snapshot.roomsById?.[target])) actions.openSession(target)
    else if (target) actions.reportError?.(new Error(t('The notification conversation is unavailable.')), 'web-push-navigation')
    if (url.searchParams.get('dsbot-pwa-setup') === '1') actions.openSettings((doc.defaultView?.innerWidth ?? globalThis.innerWidth) <= 700 ? 'notifications' : 'general')
    if (url.searchParams.has('dsbot-push') || url.searchParams.has('dsbot-pwa-setup')) {
      url.searchParams.delete('dsbot-push'); url.searchParams.delete('dsbot-pwa-setup'); hist.replaceState(hist.state, '', url.pathname + url.search + url.hash)
    }
  }
  if (roster.getSnapshot().ready) navigate()
  else { const off = roster.subscribe(() => { if (roster.getSnapshot().ready) { off(); navigate() } }); undo.push(off) }
  void readConfiguration().catch(() => {})
  return () => { for (const restore of undo) restore() }
}

const errors = {
  'push/worker-conflict': 'Another app owns this service worker. It was not replaced.',
  'push/owned-elsewhere': 'This browser subscription belongs to another device record. Unsubscribe it locally before reconnecting.',
  'push/rate-limit': 'Wait 30 seconds before sending another test.',
  'push/queue-limit': 'The notification queue is full. Try again later.',
  'push/csrf': 'Refresh the device status before trying again.',
}
export function WebPushSettings() {
  const [support, setSupport] = useState(() => pushSupport())
  const [state, setState] = useState(null)
  const [registration, setRegistration] = useState(null)
  const [hasLocalSubscription, setHasLocalSubscription] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [message, setMessage] = useState('')
  const [privateBots, setPrivateBots] = useState(false)
  const refresh = async () => { const value = await readConfiguration(); setState(value); setPrivateBots(value.includePrivate); setSupport(pushSupport()); return value }
  useEffect(() => {
    let alive = true
    void refresh().then(async () => {
      if (!support.supported || (support.ios && !support.standalone) || manifestConflict) return
      const ready = await preparePushWorker()
      const local = await ready.pushManager.getSubscription()
      if (alive) { setRegistration(ready); setHasLocalSubscription(Boolean(local)) }
    }).catch(error => { if (alive) setMessage(t(errors[error.message] ?? 'Phone notifications are unavailable on this host.')) })
    return () => { alive = false }
  }, [])
  const run = async action => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setMessage('')
    try { await action() } catch (error) { setMessage(t(errors[error.message] ?? 'The notification request could not finish. Check its status before retrying.')) }
    finally { busyRef.current = false; setBusy(false); setSupport(pushSupport()) }
  }
  const subscribe = () => run(async () => {
      // run invokes this before yielding: permission starts in the button gesture.
      const permission = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission()
      if (await permission !== 'granted') { setMessage(t('Notifications were not allowed. Change this in system settings if you want to enable them.')); return }
      if (!registration || !configuration) throw new Error('push/unavailable')
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey(configuration.publicKey) })
      setHasLocalSubscription(true)
      await change('subscribe', { subscription: subscription.toJSON(), includePrivate: privateBots, language: navigator.language })
      await refresh(); setMessage(t('This device is subscribed. Use the test button and check its notification center.'))
    })
  const unsubscribe = () => run(async () => {
    await change('unsubscribe')
    const own = await ownedRegistration()
    if (own) { const subscription = await own.pushManager.getSubscription(); await subscription?.unsubscribe(); await own.unregister() }
    noteOwned(false); setRegistration(null); setHasLocalSubscription(false); await refresh(); setMessage(t('This device is unsubscribed. Other devices were not changed.'))
  })
  const test = () => run(async () => { await change('test'); await refresh(); setMessage(t('Test queued. A push-service acknowledgement is not proof that the phone received it.')) })
  let status = 'Preparing phone notifications…'
  if (!support.supported) status = 'This browser does not support Web Push here.'
  if (support.ios && !support.standalone) status = 'On iPhone or iPad, add this page to the Home Screen and open its icon first (iOS 16.4+).'
  else if (support.permission === 'denied') status = 'Notification permission is denied. Enable it in system settings before subscribing.'
  else if (state?.subscribed && hasLocalSubscription && support.permission === 'granted') status = 'This device is subscribed.'
  else if (registration && state) status = 'Ready to request notification permission.'
  const eligible = support.supported && (!support.ios || support.standalone) && !manifestConflict
  const last = state?.lastTest?.state
  return h('div', { className: 'bt-web-push', 'data-web-push-status': state?.subscribed ? 'subscribed' : support.permission },
    h('p', { role: 'status' }, t(status)),
    h('p', { className: 'bt-set-hint' }, t('Generic reminders only. Opening conversation details still requires Tailscale; delivery can be delayed by the system.')),
    !support.standalone ? h('a', { className: 'bt-soft', href: '/?dsbot-pwa=1&dsbot-pwa-setup=1' }, t('Prepare Home Screen installation')) : null,
    manifestConflict ? h('p', { role: 'alert' }, t('An existing app manifest was preserved. Use that app or resolve the conflict before installing this one.')) : null,
    h('label', { className: 'bt-web-push-private' }, h('input', { type: 'checkbox', checked: privateBots, disabled: busy, onChange: event => setPrivateBots(event.target.checked) }), t('Include private Bots visible to me on this device')),
    h('div', { className: 'bt-web-push-actions' },
      h('button', { type: 'button', className: 'bt-soft', disabled: busy || !eligible || !registration || !state || support.permission === 'denied', onClick: subscribe }, t(state?.subscribed ? 'Update this device subscription' : 'Enable on this device')),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy || !state?.subscribed || !hasLocalSubscription || support.permission !== 'granted', onClick: test }, t('Send test notification')),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy || (!state?.subscribed && !hasLocalSubscription), onClick: unsubscribe }, t('Unsubscribe this device')),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => run(async () => { await refresh(); if (eligible && !registration) { const ready = await preparePushWorker(); setRegistration(ready); setHasLocalSubscription(Boolean(await ready.pushManager.getSubscription())) } }) }, t('Check device status'))),
    last ? h('p', { className: 'bt-set-hint' }, t(last === 'accepted' ? 'The push service accepted the test. Check the device to confirm receipt.' : last === 'unknown' ? 'The test result is unknown. Check the device before sending another.' : last === 'queued' ? 'Test notification is queued.' : 'The push service did not accept the test.')) : null,
    message ? h('p', { role: 'status' }, message) : null,
  )
}
export const WEB_PUSH_CSS = `.bt-web-push{display:flex;flex-direction:column;gap:10px;padding:14px;min-width:0}.bt-web-push p{margin:0;overflow-wrap:anywhere}.bt-web-push-actions{display:flex;flex-wrap:wrap;gap:8px}.bt-web-push-private{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}.bt-web-push .bt-soft{width:auto;max-width:100%;white-space:normal;text-align:center}`
