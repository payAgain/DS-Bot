import { createElement as h, useRef, useState } from 'react'
import { currentPart } from './text.js'
import { t } from './i18n.js'
import { SecretDock } from './secret-card.js'
import { ConnectorDock, MailDock } from './connectors.js'
import { QuestionDock } from './questions.js'
import { WidgetDock } from './widget-cell.js'
import { LearningDock } from './learning-card.js'
import { HandoffDock } from './handoff-card.js'
import { AppAccessDock, ComputerHandoffDock } from './computer.js'
import { ReviewLink } from './review-link.js'
import { pendingReviewSources, reviewHome } from './review-inbox-model.js'

const EMPTY = {}
const noDrawnCards = select => select(EMPTY)

export function ExecutionReview({ approval, actions }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const flying = useRef(false)
  const answer = choice => {
    if (flying.current) return
    flying.current = true; setBusy(true); setError('')
    void Promise.resolve().then(() => actions.answerApproval(approval.id, choice))
      .catch(failure => setError(failure?.message ?? String(failure)))
      .finally(() => { flying.current = false; setBusy(false) })
  }
  return h('section', { className: 'bt-q bt-mw-card', role: 'group', 'aria-label': t('Approval required'), 'data-request-id': approval.id },
    h('strong', null, approval.tool || t('Approval required')),
    approval.detail?.text ? h('p', null, approval.detail.text) : null,
    h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, approval.fullReason || approval.reason),
    approval.detail?.code ? h('pre', { className: 'bt-mw-code', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, approval.detail.code) : null,
    h('p', { className: 'bt-set-hint' }, t('This decision applies to this request only.')),
    approval.reasonTruncated ? h('p', { role: 'alert' }, t('The request is incomplete. Reject it or review the full operation before allowing it.')) : null,
    error ? h('p', { role: 'alert' }, error) : null,
    h('div', { className: 'bt-mw-actions' },
      h('button', { type: 'button', className: 'bt-q-btn', disabled: busy || !approval.answerable, onClick: () => answer('reject') }, t('Reject')),
      h('button', { type: 'button', className: 'bt-q-submit', disabled: busy || !approval.answerable || approval.reasonTruncated, onClick: () => answer('allow') }, t('Allow once'))))
}

// The Main Bot inbox owns pending interactions; source docks only route to it.
export const routeRequestDock = Component => function SourceRequestDock(props) {
  const home = props.useRoster(reviewHome)
  return home ? null : h(Component, props)
}

// Cards keep their source Session and original request id. This is another view of
// the same request, never a relay message or a new approval issued by the Main Bot.
export function ReviewInboxDock(props) {
  const { sessionId, useRoster, useWork, useBrowserHolds, useComputer, actions } = props
  const roster = useRoster(value => value)
  const work = useWork?.(value => value) ?? EMPTY
  const holds = useBrowserHolds?.(value => value) ?? EMPTY
  const computer = useComputer?.(value => value) ?? EMPTY
  const home = reviewHome(roster)
  if (!home) return null
  const sources = pendingReviewSources(roster, work, holds, computer)
  if (!sources.length) return null
  if (currentPart(home) !== sessionId) {
    if (!sources.some(source => source.sessionId === sessionId)) return null
    return h('div', { className: 'bt-q-dock bt-review-route' }, h(ReviewLink, { home, sessionId, actions }))
  }
  const count = sources.reduce((total, source) => total + source.count, 0)
  return h('section', { className: 'bt-review-inbox', tabIndex: -1, 'aria-label': t('Pending approvals and confirmations') },
    h('header', { className: 'bt-review-head' },
      h('span', null, t('Waiting for your review')),
      h('span', { className: 'bt-review-count' }, count)),
    h('div', { className: 'bt-review-list' }, sources.map(source => {
      const cardProps = { ...props, sessionId: source.sessionId, useCards: noDrawnCards, reviewInbox: true }
      return h('section', { key: source.bot.id, 'data-source-bot': source.bot.id, className: 'bt-review-source' },
        h('div', { className: 'bt-review-source-name' }, source.bot.name),
        source.approvals.map(approval => h(ExecutionReview, { key: approval.id, approval, actions })),
        ...[[QuestionDock, source.question], [WidgetDock, source.view], [SecretDock, source.secret.length], [ConnectorDock, source.connector.length], [MailDock, source.mail.length], [HandoffDock, source.browser], [ComputerHandoffDock, source.handoff], [AppAccessDock, source.apps.length], [LearningDock, source.learning.length]]
          .filter(([, pending]) => pending).map(([Component], index) => h(Component, { key: Component.name || index, ...cardProps })))
    })))
}

export const REVIEW_INBOX_CSS = `
.bt-review-inbox{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,748px);min-width:0;margin:4px auto 8px;outline:none}
.bt-review-head{display:flex;align-items:center;gap:8px;padding:4px 2px 8px;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-review-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;box-sizing:border-box;border-radius:999px;background:var(--bt-hover);font-variant-numeric:tabular-nums}
.bt-review-list{max-height:min(44dvh,420px);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:12px;padding:0 2px 2px}
.bt-review-source{min-width:0;display:flex;flex-direction:column;gap:6px}
.bt-review-source-name{font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-review-inbox .bt-q-dock,.bt-review-inbox .bt-learning-dock{width:100%;max-width:none;padding:0;margin:0;min-width:0}
.bt-review-inbox .bt-q{width:100%;max-width:none;margin:0;box-shadow:none;border-radius:12px;overflow:hidden}
.bt-review-inbox .bt-q-head{padding:12px}
.bt-review-inbox .bt-q-title{font-size:13px;line-height:18px}
.bt-review-inbox .bt-q-foot{padding:8px 12px 12px;gap:8px;flex-wrap:wrap;background:var(--bt-card)}
.bt-review-inbox .bt-q-btn,.bt-review-inbox .bt-q-submit{min-height:32px;font-size:13px}
.bt-review-inbox .bt-mw-card{padding:12px;box-sizing:border-box;overflow-wrap:anywhere}
.bt-review-inbox .bt-mw-card p{margin:6px 0;font-size:13px;line-height:18px}
.bt-review-inbox .bt-mw-code{max-height:160px;overflow:auto;font-size:12px}
.bt-review-inbox .bt-mw-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:8px}
.bt-review-link{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-review-route{padding:4px 0}
.bt-review-scope{padding:0 12px;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
@media(max-width:520px){.bt-review-list{max-height:40dvh}.bt-review-inbox .bt-q-foot{gap:6px}.bt-review-inbox .bt-q-btn,.bt-review-inbox .bt-q-submit{padding-inline:12px}}
`
