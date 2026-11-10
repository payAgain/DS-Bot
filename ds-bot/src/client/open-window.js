// A page that opens once a request answers with its address. In a browser the window
// is reserved inside the click gesture and addressed later: opening after the awaits
// would hit the popup blocker. The Desktop makes no window. It hands an http(s)
// address to the system browser, has no blocker, and returns null even then, so it
// gets the address itself. `close()` drops a reserved window nothing needed, and is a
// no-op once `go()` has navigated it — the sign-in page must stay open.
export function reserveWindow() {
  if (window.dshDesktop !== undefined) return { go: (url) => { window.open(url, '_blank'); return true }, close: () => {} }
  const reserved = window.open('', '_blank')
  if (reserved !== null) reserved.opener = null
  let used = false
  return {
    go: (url) => {
      if (used || reserved === null) return false
      used = true
      try { reserved.location.href = url } catch { return false }
      return true
    },
    close: () => { if (!used) { try { reserved?.close() } catch { /* the window may already be gone */ } } },
  }
}

// Opens an address now, inside the current click.
export const openPage = url => reserveWindow().go(url)
