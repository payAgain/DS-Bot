import { createElement as h, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, SlidersIcon } from './icons.js'
import { AccountLauncher } from './sidebar.js'
import { t } from './i18n.js'

const phoneSnapshot = () => typeof window !== 'undefined' && window.innerWidth <= 700
const phoneSubscribe = listener => {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('resize', listener)
  return () => window.removeEventListener('resize', listener)
}
export const usePhoneSettings = () => useSyncExternalStore(phoneSubscribe, phoneSnapshot, () => false)
import { settingsGroups } from './mobile-settings-model.js'
export function PhoneSettingsHeader({ home, title, back }) {
  return h('div', { className: 'bt-phone-settings-header' },
    home ? h('span', { className: 'bt-phone-settings-back-space' }) : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back'), onClick: back }, h(ChevronLeftIcon)),
    h('h2', null, home ? t('Settings') : title),
    h('span', { className: 'bt-phone-settings-back-space' }))
}
export function PhoneSettingsHome({ pages, extra = [], icons, actions, scroll, accountOpen }) {
  const root = useRef(null)
  useLayoutEffect(() => { if (root.current) root.current.scrollTop = scroll.current }, [])
  const row = entry => h('button', { key: entry.id, type: 'button', className: 'bt-phone-settings-row', 'data-settings-page': entry.id,
    onClick: () => entry.open ? entry.open() : actions.openSettings(entry.id) },
  h('span', { className: 'bt-phone-settings-icon', 'aria-hidden': true }, h(icons[entry.id] ?? SlidersIcon)),
  h('span', { className: 'bt-phone-settings-label' }, t(entry.label)), h(ChevronRightIcon))
  return h('div', { className: 'bt-phone-settings-home', ref: root, onScroll: () => { scroll.current = root.current?.scrollTop ?? 0 } },
    h('div', { className: 'bt-phone-settings-account' }, accountOpen ? h('button', { type: 'button', className: 'bt-account', 'aria-label': t('Account'), onClick: accountOpen }, h('span', { className: 'bt-you', 'aria-hidden': true }, 'DS')) : h(AccountLauncher, { seat: false, actions }), h('span', { className: 'bt-phone-settings-account-label', 'aria-hidden': true }, t('Account')), h(ChevronRightIcon)),
    settingsGroups(pages, extra).map(group => h('section', { key: group.label, className: 'bt-phone-settings-group' },
      h('h3', null, t(group.label)), h('div', { className: 'bt-phone-settings-card' }, group.rows.map(row)))))
}
export const PHONE_SETTINGS_CSS = `
.bt-phone-settings-header{display:none}
.bt-settings-item[data-phone-only]{display:none}
@media(max-width:700px){
.bt-settings-nav{display:none}
.bt-phone-settings-header{display:flex;align-items:center;flex:none;min-height:60px;gap:8px;padding:env(safe-area-inset-top,0px) 8px 0;box-sizing:border-box;border-bottom:.5px solid var(--bt-line);background:var(--bt-main)}
.bt-phone-settings-header h2{flex:1;min-width:0;margin:0;text-align:center;font-size:17px;line-height:24px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-phone-settings-back-space{width:44px;flex:none}
.bt-settings-close{top:calc(8px + env(safe-area-inset-top,0px))}
.bt-settings-head{display:none}
.bt-settings-main{min-height:0;min-width:0;width:100%;flex:1}
.bt-settings-scroll{padding:16px 16px calc(24px + env(safe-area-inset-bottom,0px));gap:20px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}
.bt-phone-settings-home{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:20px 16px calc(28px + env(safe-area-inset-bottom,0px));background:var(--bt-sidebar);box-sizing:border-box}
.bt-phone-settings-group{margin-top:24px}
.bt-phone-settings-group h3{margin:0 12px 8px;font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2)}
.bt-phone-settings-card,.bt-phone-settings-account{overflow:hidden;border-radius:16px;background:var(--bt-card);border:.5px solid var(--bt-line)}
.bt-phone-settings-row{display:flex;align-items:center;gap:12px;min-height:56px;width:100%;padding:12px 14px;border:0;background:none;color:var(--bt-ink);font:inherit;font-size:16px;line-height:22px;text-align:left;box-sizing:border-box;cursor:pointer;touch-action:manipulation}
.bt-phone-settings-row+.bt-phone-settings-row{border-top:.5px solid var(--bt-line)}
.bt-phone-settings-row:active{background:var(--bt-active)}
.bt-phone-settings-row:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-phone-settings-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;flex:none;color:var(--bt-ink-2)}
.bt-phone-settings-icon svg{width:20px;height:20px}
.bt-phone-settings-label{min-width:0;flex:1;overflow-wrap:anywhere}
.bt-phone-settings-row>svg,.bt-phone-settings-account>svg{width:16px;height:16px;flex:none;color:var(--bt-ink-3)}
.bt-phone-settings-account{position:relative;display:flex;align-items:center;min-height:64px}
.bt-phone-settings-account>.bt-account{position:relative;z-index:1;display:flex;align-items:center;width:100%;height:64px;min-height:64px;border-radius:0;padding:0 16px;background:transparent}
.bt-phone-settings-account .bt-you{width:32px;height:32px;flex:none}
.bt-phone-settings-account-label{position:absolute;left:64px;right:40px;font-size:17px;line-height:24px;pointer-events:none}
.bt-phone-settings-account>svg{position:absolute;right:16px;pointer-events:none}
.bt-settings .bt-set-card{border-radius:16px;overflow:hidden}
.bt-settings .bt-set-row{padding:14px;min-height:54px;gap:10px}
.bt-settings .bt-set-copy>span:first-child{font-size:15px;line-height:21px}
.bt-settings .bt-set-hint{font-size:13px;line-height:19px}
.bt-settings .bt-set-control{width:100%;justify-content:flex-start;min-width:0}
.bt-settings :is(input,textarea,select){box-sizing:border-box;max-width:100%}
.bt-settings .bt-bs-input,.bt-settings .bt-input,.bt-settings .bt-select{width:100%;min-height:44px}
.bt-settings .bt-input[type=range],.bt-settings .bt-input[type=color]{width:auto}
.bt-settings .bt-actions{flex-wrap:wrap;gap:8px}
.bt-settings .bt-actions>.bt-soft{flex:1 1 auto;min-height:44px}
.bt-settings .bt-send,.bt-settings .bt-task-foot button{min-height:44px}
.bt-settings-usage[data-off]{display:none}
}
`
