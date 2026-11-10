import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { reserveWindow, openPage } from '../src/client/open-window.js'

// open-window reads `window` at call time, so each test installs its own stand-in.
const originalWindow = globalThis.window
afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
})

const fakeWindow = () => ({ opener: 'opener', location: {}, closed: 0, close() { this.closed++ } })

test('browser: go addresses the reserved window and detaches its opener', () => {
  const win = fakeWindow()
  globalThis.window = { open: () => win }
  const page = reserveWindow()
  assert.equal(win.opener, null)
  assert.equal(page.go('https://example.test/sign-in'), true)
  assert.equal(win.location.href, 'https://example.test/sign-in')
})

test('browser: close drops an unused blank window but never a navigated one', () => {
  const navigated = fakeWindow()
  globalThis.window = { open: () => navigated }
  const page = reserveWindow()
  page.go('https://example.test/a')
  page.close()
  assert.equal(navigated.closed, 0, 'the sign-in page must stay open')

  const blank = fakeWindow()
  globalThis.window = { open: () => blank }
  reserveWindow().close()
  assert.equal(blank.closed, 1, 'an unused blank window is closed')
})

test('browser: a blocked popup reports failure instead of throwing', () => {
  globalThis.window = { open: () => null }
  assert.equal(reserveWindow().go('https://example.test/x'), false)
  assert.equal(openPage('https://example.test/x'), false)
})

test('desktop: go hands the address to the system browser', () => {
  const opened = []
  globalThis.window = { dshDesktop: {}, open: (url, target) => { opened.push([url, target]); return null } }
  assert.equal(reserveWindow().go('https://example.test/desk'), true)
  assert.deepEqual(opened, [['https://example.test/desk', '_blank']])
})
