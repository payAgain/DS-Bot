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

// The old raised docks are replaced by the Main Bot's inbox. Inline transcript
// cards remain mirrors of the same id and withdraw when the inbox resolves it.
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
  if (!sources.length) return currentPart(home) === sessionId
    ? h('div', { className: 'bt-q-dock bt-review-inbox-empty', role: 'status', style: { padding: '8px 12px', color: 'var(--bt-ink-2)', fontSize: 12 } }, t('Team approvals and confirmations'), ' · ', t('No pending requests in this inbox.'))
    : null
  if (currentPart(home) !== sessionId) {
    if (!sources.some(source => source.sessionId === sessionId)) return null
    return h('div', { className: 'bt-q-dock' },
      h('span', null, t('Review this request with {name}.', { name: home.name })), ' ',
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSession(home.id) }, t('Open {name}', { name: home.name })))
  }
  return h('details', { className: 'bt-review-inbox', open: true, style: { width: '100%', maxWidth: 748, margin: '8px auto', border: '1px solid var(--bt-line)', borderRadius: 16, padding: 12 } },
    h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, t('Team approvals and confirmations')),
    h('p', { className: 'bt-set-hint' }, t('You decide here. Each Bot receives the result for its original request.')),
    h('div', { style: { maxHeight: '60vh', overflowY: 'auto', overscrollBehavior: 'contain' } }, sources.map(source => {
      // Own cards already visible inline stay there; other Bots are always raised here.
      const cardProps = { ...props, sessionId: source.sessionId, useCards: source.bot.id === home.id ? props.useCards : noDrawnCards, reviewInbox: true }
      return h('section', { key: source.bot.id, 'data-source-bot': source.bot.id, style: { marginTop: 14 } },
        h('h3', { style: { fontSize: 14, margin: '8px 0' } }, t('From {name}', { name: source.bot.name })),
        source.approvals.map(approval => h(ExecutionReview, { key: approval.id, approval, actions })),
        ...[QuestionDock, WidgetDock, SecretDock, ConnectorDock, MailDock, HandoffDock, ComputerHandoffDock, AppAccessDock, LearningDock]
          .map((Component, index) => h(Component, { key: index, ...cardProps })))
    })))
}
