// Phone-only geometry. VisualViewport shrinks for the keyboard, while fixed CSS
// bottom offsets still use the layout viewport. Pinch zoom is left to the browser.
export function phoneViewport(env) {
  if (env.innerWidth > 700) return null
  const vv = env.visualViewport
  if (vv && Math.abs((vv.scale ?? 1) - 1) > 0.05) return undefined
  const top = Math.max(0, vv?.offsetTop ?? 0)
  const height = Math.max(1, Math.min(vv?.height ?? env.innerHeight, env.innerHeight - top))
  return { top, height }
}
export const fixedBottom = (top, gap = 0, env = window) => Math.max(0, env.innerHeight - top + gap)
export function installPhoneViewport(env = window, doc = document) {
  const body = doc.body, style = body.style
  const meta = doc.querySelector?.('meta[name="viewport"]')
  const originalMeta = meta?.content
  const fittedMeta = originalMeta && !/viewport-fit\s*=/.test(originalMeta) ? `${originalMeta}, viewport-fit=cover` : undefined
  let frame = 0
  const clear = () => {
    delete body.dataset.btMobileViewport; style.removeProperty('--bt-phone-height'); style.removeProperty('--bt-phone-top')
    if (meta && fittedMeta && meta.content === fittedMeta) meta.content = originalMeta
  }
  const measure = () => {
    frame = 0
    const view = phoneViewport(env)
    if (view === undefined) return
    if (view === null) { clear(); return }
    body.dataset.btMobileViewport = ''
    if (meta && fittedMeta && meta.content === originalMeta) meta.content = fittedMeta
    style.setProperty('--bt-phone-height', `${Math.round(view.height)}px`)
    style.setProperty('--bt-phone-top', `${Math.round(view.top)}px`)
  }
  const schedule = () => { if (!frame) frame = env.requestAnimationFrame(measure) }
  const vv = env.visualViewport
  for (const target of [env, vv].filter(Boolean)) { target.addEventListener('resize', schedule); target.addEventListener('scroll', schedule) }
  measure()
  return () => {
    env.cancelAnimationFrame(frame)
    for (const target of [env, vv].filter(Boolean)) { target.removeEventListener('resize', schedule); target.removeEventListener('scroll', schedule) }
    clear()
  }
}
export const PHONE_LAYOUT_CSS = `
@media(max-width:700px){
body[data-bt-mobile-viewport] [class*="_frame"]:has(.bt-head){height:var(--bt-phone-height,100dvh)!important;max-height:var(--bt-phone-height,100dvh);min-height:0!important;margin-top:var(--bt-phone-top,0px)!important}
.bt-mobile-drawer-backdrop{position:fixed;inset:0;z-index:24;border:0;background:color-mix(in srgb,var(--bt-ink) 24%,transparent);touch-action:manipulation}
.bt-leftcol[data-left=drawer]{max-width:calc(100vw - 48px);top:var(--bt-phone-top,0px);bottom:auto;height:var(--bt-phone-height,100dvh);padding-top:calc(8px + env(safe-area-inset-top,0px));padding-bottom:calc(8px + env(safe-area-inset-bottom,0px))}
.bt-leftcol-grip{display:none}
html:not([data-windows-titlebar]) .bt-title-toggle{top:calc(var(--bt-phone-top,0px) + 12px + env(safe-area-inset-top,0px));left:max(10px,env(safe-area-inset-left,0px))}
header[class*="_header"]:has(.bt-head)>[class*="_headerLeading"]{display:none!important}
header[class*="_header"]:has(.bt-head){padding-top:calc(8px + env(safe-area-inset-top,0px))!important}
.bt-head{padding-inline:60px;box-sizing:border-box}
.bt-pill{max-width:100%;min-width:0}
.bt-pill-go{width:16px;margin-left:0;opacity:1;filter:none;transform:none}
.bt-settings-layer,.bt-mem-layer,.bt-palette-layer{top:var(--bt-phone-top,0px);bottom:auto;height:var(--bt-phone-height,100dvh);box-sizing:border-box}
.bt-settings{--bt-set-w:100%;--bt-set-h:100%;width:100%;height:100%;max-height:100%;border-radius:0;border:0;flex-direction:column}
.bt-settings-nav{padding-top:calc(8px + env(safe-area-inset-top,0px));min-height:60px}
.bt-settings-main{flex:1;min-height:0;width:100%;height:auto}
.bt-settings-head{flex-shrink:0}
.bt-settings-scroll{min-height:0;overscroll-behavior:contain;scroll-padding-block:16px}
.bt-settings-close{top:calc(8px + env(safe-area-inset-top,0px));right:8px;z-index:3}
.bt-mem,.bt-palette{max-width:calc(100% - 16px);max-height:calc(100% - 16px);min-height:0}
.bt-panel{top:var(--bt-phone-top,0px);bottom:auto;height:var(--bt-phone-height,100dvh);max-width:100vw}
.bt-panel-grip{display:none}
.bt-menu,.bt-model-menu{max-width:calc(100vw - 16px);max-height:calc(var(--bt-phone-height,100dvh) - 16px);overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box}
[data-composer-card]{border-radius:18px!important;row-gap:4px!important}
[class*="_root"]:has(>[data-composer-card]){padding:0 max(12px,env(safe-area-inset-right,0px)) calc(8px + env(safe-area-inset-bottom,0px)) max(12px,env(safe-area-inset-left,0px))!important}
[data-composer-card]>[data-input-scroll]{order:0!important;flex:1 0 100%!important;box-sizing:border-box;padding:2px 8px 4px!important;max-height:min(160px,30dvh);overflow-y:auto}
[data-composer-card] [class*="_tools"]{order:1!important}
[data-composer-card] [class*="_trailing"]{order:2!important;margin-left:auto!important}
[data-composer-card] [data-composer-input]{font-size:16px!important;line-height:24px!important}
[data-composer-placeholder]::before{font-size:16px!important}
.bt-plus,.bt-mic,.bt-voice,[data-composer-card] button[class*="_primary"]{width:44px!important;height:44px!important;flex-shrink:0}
.bt-round,.bt-icon-btn,.bt-title-toggle,.bt-settings-close,.bt-account{min-width:44px;min-height:44px}
.bt-settings-item,.bt-menu button,.bt-menu [role=menuitem],.bt-model-pick,.bt-model-row{min-height:44px}
.bt-settings :is(input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),textarea,select),.bt-q :is(input,textarea),.dv-view :is(input,textarea),.bt-model-search input{font-size:16px}
.bt-q-foot{flex-wrap:wrap}
.bt-review-inbox{max-height:calc(var(--bt-phone-height,100dvh) * .38);display:flex;flex-direction:column}
.bt-review-head{flex-shrink:0}
.bt-review-list{min-height:0;max-height:calc(var(--bt-phone-height,100dvh) * .30)}
.dv-view button,.dv-q button,.bt-review-inbox .bt-q-btn,.bt-review-inbox .bt-q-submit,[data-slot="conversation.input.attachments"] button{min-height:44px;min-width:44px}
.bt-q,.dv-view,.dv-q{min-width:0;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}
.bt-q :is(input,textarea),.dv-view :is(input,textarea){min-width:0;max-width:100%;box-sizing:border-box}
.bt-settings :is(.bt-set-control,.bt-seg){min-width:0;max-width:100%;flex-wrap:wrap}
.bt-settings .bt-soft{white-space:normal;overflow-wrap:anywhere;min-height:44px}
.bt-settings .bt-swatch{width:36px;height:36px}
[data-chat-flow] :is(img,video){max-width:100%;height:auto}
[data-chat-flow] :is([data-file-path],[data-attachment-id]){min-width:0;max-width:100%;overflow-wrap:anywhere}
.bt-web-push-actions>.bt-soft{flex:1 1 140px;min-height:44px}
}
`
