import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixedBottom, phoneViewport, installPhoneViewport } from '../src/client/mobile-layout.js'
import { frameLayout } from '../src/client/frame-layout.js'

test('phone drawers preserve the entire chat width and do not change desktop preferences', () => {
  for (const viewport of [360, 375, 390, 430]) for (const pref of ['open', 'rail', 'hidden']) {
    const input = { viewport, sidebarWidth: 280, pref }
    assert.deepEqual(frameLayout(input), { left: 'hidden', panel: 'none', column: 0, room: viewport })
    assert.deepEqual(frameLayout({ ...input, drawer: true }), { left: 'drawer', panel: 'none', column: 0, room: viewport })
    assert.equal(input.pref, pref)
  }
  assert.equal(frameLayout({ viewport: 1280, sidebarWidth: 280, pref: 'open' }).left, 'open')
})

test('a keyboard changes visible height, but fixed bottom offsets still use layout height', () => {
  const env = { innerWidth: 390, innerHeight: 844, visualViewport: { height: 420, offsetTop: 30, scale: 1 } }
  assert.deepEqual(phoneViewport(env), { top: 30, height: 420 })
  const anchor = 360
  const bottom = fixedBottom(anchor, 8, env)
  assert.equal(env.innerHeight - bottom, anchor - 8)
  assert.equal(bottom, 492)
  assert.deepEqual(phoneViewport({ innerWidth: 360, innerHeight: 480 }), { top: 0, height: 480 })
})

test('pinch zoom is not mistaken for a keyboard and desktop layout is not resized', () => {
  assert.equal(phoneViewport({ innerWidth: 390, innerHeight: 844, visualViewport: { height: 300, scale: 2 } }), undefined)
  assert.equal(phoneViewport({ innerWidth: 1280, innerHeight: 800 }), null)
})

test('phone viewport follows resize, restores the viewport meta, and releases all event listeners', () => {
  const env = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 844 })
  env.visualViewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 })
  const frames = new Map(); let serial = 0
  env.requestAnimationFrame = fn => { frames.set(++serial, fn); return serial }
  env.cancelAnimationFrame = id => frames.delete(id)
  const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn() }
  const values = new Map(), body = { dataset: {}, style: { setProperty: (k, v) => values.set(k, v), removeProperty: k => values.delete(k) } }
  const meta = { content: 'width=device-width, initial-scale=1' }
  const stop = installPhoneViewport(env, { body, querySelector: () => meta })
  assert.equal(values.get('--bt-phone-height'), '844px')
  assert.match(meta.content, /viewport-fit=cover/)
  env.visualViewport.height = 420
  env.visualViewport.dispatchEvent(new Event('resize')); flush()
  assert.equal(values.get('--bt-phone-height'), '420px')
  env.visualViewport.scale = 2; env.visualViewport.height = 210
  env.visualViewport.dispatchEvent(new Event('resize')); flush()
  assert.equal(values.get('--bt-phone-height'), '420px')
  env.innerWidth = 1280; env.dispatchEvent(new Event('resize')); flush()
  assert.equal(values.size, 0)
  assert.equal(meta.content, 'width=device-width, initial-scale=1')
  stop(); env.dispatchEvent(new Event('resize')); flush()
  assert.equal(values.size, 0)
  assert.equal(frames.size, 0)
})
