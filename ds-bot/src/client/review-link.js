import { createElement as h } from 'react'
import { currentPart } from './text.js'
import { t } from './i18n.js'

export function openReview(home, sessionId, actions) {
  if (currentPart(home) !== sessionId) return actions.openSession(home.id)
  const inbox = document.querySelector('.bt-review-inbox')
  inbox?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  inbox?.focus({ preventScroll: true })
}

export function ReviewLink({ home, sessionId, actions }) {
  return h('div', { className: 'bt-review-link', role: 'status' },
    h('span', null, t('Waiting for your review')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => openReview(home, sessionId, actions) }, t('Review with {name}', { name: home.name })))
}
