import { useLayoutEffect, useMemo } from 'react'

export const REPLY_HOLD_MS = 520
const MOVE_LIMIT = 10
const heldClicks = new WeakMap()
export function consumeReplyClick(event) {
  const element = event.target?.nodeType === 3 ? event.target.parentElement : event.target
  const bubble = element?.closest?.('[data-reply-hold]')
  return bubble ? heldClicks.get(bubble)?.(event) === true : false
}
const INTERACTIVE = 'a,button,input,textarea,select,option,summary,details,pre,code,img,video,audio,iframe,canvas,svg,[role=button],[role=link],[contenteditable=true],[data-slot],[data-call-id],[data-file-path],[data-file-mention],[data-attachment-id],[data-receipt-id],.bt-q,.bt-widget,.bt-file,.bt-attachment'
const selected = doc => doc.defaultView?.getSelection?.()?.isCollapsed === false

// iOS reserves a hold on text for selection/copy. Only bubble padding, paragraph
// gaps and space after a line take this shortcut; text and links retain native use.
export function replySpace(root, target, x, y) {
  const element = target?.nodeType === 3 ? target.parentElement : target
  const control = element?.closest?.(INTERACTIVE)
  if (!element || !root.contains(element) || (control && root.contains(control)) || selected(root.ownerDocument)) return false
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, 4)
  const range = doc.createRange()
  let node, visited = 0
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim()) continue
    if (++visited > 2000) return false
    range.selectNodeContents(node)
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0 && x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) return false
    }
  }
  return true
}

export function createReplyHold({ reply, eligible = replySpace, now = Date.now, schedule = (fn, delay) => setTimeout(fn, delay), unschedule = id => clearTimeout(id) }) {
  let active = null, completed = null, timer = null, off = () => {}
  const cancel = () => {
    if (timer !== null) unschedule(timer)
    timer = null; active = null; off(); off = () => {}
  }
  const down = event => {
    cancel(); if (completed) heldClicks.delete(completed.root); completed = null
    if (event.pointerType !== 'touch' || event.isPrimary === false || event.button > 0) return
    const root = event.currentTarget
    if (!eligible(root, event.target, event.clientX, event.clientY)) return
    const doc = root.ownerDocument, view = doc.defaultView
    const press = { id: event.pointerId, root, x: event.clientX, y: event.clientY }
    active = press
    const selection = () => { if (selected(doc)) cancel() }
    const another = next => { if (next.pointerId !== press.id) cancel() }
    doc.addEventListener('scroll', cancel, true)
    doc.addEventListener('selectionchange', selection)
    doc.addEventListener('pointerdown', another, true)
    doc.addEventListener('visibilitychange', cancel)
    view?.addEventListener('blur', cancel)
    off = () => {
      doc.removeEventListener('scroll', cancel, true)
      doc.removeEventListener('selectionchange', selection)
      doc.removeEventListener('pointerdown', another, true)
      doc.removeEventListener('visibilitychange', cancel)
      view?.removeEventListener('blur', cancel)
    }
    timer = schedule(() => {
      timer = null
      if (active !== press || selected(doc)) { cancel(); return }
      completed = { id: press.id, root, until: now() + 1500 }
      heldClicks.set(root, click)
      reply()
    }, REPLY_HOLD_MS)
  }
  const move = event => {
    if (active?.id === event.pointerId && Math.hypot(event.clientX - active.x, event.clientY - active.y) > MOVE_LIMIT) cancel()
  }
  const up = event => {
    if (completed?.id === event.pointerId) completed.until = now() + 700
    if (active?.id === event.pointerId) cancel()
  }
  const pointerCancel = event => {
    if (completed?.id === event.pointerId) completed.until = now() + 700
    if (active?.id === event.pointerId) cancel()
  }
  const click = event => {
    if (!completed || now() > completed.until || (event.detail === 0 && event.pointerType !== 'touch')) return false
    event.preventDefault(); event.stopPropagation(); heldClicks.delete(completed.root); completed = null
    return true
  }
  const context = event => {
    // Suppress only the native callout belonging to an eligible blank-space hold.
    // Never intercept text selection, links, desktop menus or unrelated presses.
    if ((active || completed && now() <= completed.until) && !selected(event.currentTarget.ownerDocument)) {
      const root = event.currentTarget
      if (eligible(root, event.target, event.clientX, event.clientY)) event.preventDefault()
    }
  }
  return {
    handlers: { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: pointerCancel, onLostPointerCapture: pointerCancel, onPointerLeave: cancel, onClickCapture: click, onContextMenu: context },
    dispose() { cancel(); if (completed) heldClicks.delete(completed.root); completed = null },
  }
}

export function useReplyHold({ sessionId, text, enabled, actions }) {
  const hold = useMemo(() => createReplyHold({ reply: () => { if (enabled && sessionId) actions.quote(sessionId, text) } }), [sessionId, text, enabled, actions])
  useLayoutEffect(() => () => hold.dispose(), [hold])
  return enabled && sessionId && text.trim() ? hold.handlers : {}
}
