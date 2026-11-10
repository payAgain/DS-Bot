import { t } from './i18n.js'
import { currentPart } from './text.js'
import { reviewHome } from './review-inbox-model.js'

// A system notification for each approval that starts waiting while this window is in
// the background or shows another conversation. Only where the platform already allows
// notifications: DS Bot never asks for the permission.
export function noticeApprovals({ work, roster, shownSession, openSession, since = Date.now() }) {
  const told = new Set()
  const notify = () => {
    const approvals = work.getSnapshot().approvals ?? []
    for (const id of told) {
      if (!approvals.some(entry => entry.id === id)) told.delete(id)
    }
    if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
    for (const entry of approvals) {
      if (told.has(entry.id)) continue
      told.add(entry.id)
      // Waiting before this window opened is no news: the sidebar shows it.
      if ((entry.at ?? 0) < since) continue
      const snapshot = roster.getSnapshot()
      const home = reviewHome(snapshot)
      const place = home ? currentPart(home) : entry.roomId ?? entry.sessionId
      if (document.visibilityState === 'visible' && shownSession() === place) continue
      const { byId, roomsById } = snapshot
      const room = entry.roomId ? roomsById[entry.roomId] : undefined
      const note = new Notification(t('{name} is waiting for your approval', { name: byId[entry.botId]?.name ?? t('A Bot') }), {
        body: [room?.name, entry.tool].filter(Boolean).join(' · '),
        tag: `ds-bot-approval-${entry.id}`,
      })
      note.onclick = () => {
        window.focus()
        openSession(reviewHome(roster.getSnapshot())?.id ?? entry.roomId ?? entry.botId)
        note.close()
      }
    }
  }
  notify()
  return work.subscribe(notify)
}
