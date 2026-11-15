import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const requireHarness = createRequire(fileURLToPath(new URL('../dev/harness/package.json', import.meta.url)))
const { JSDOM } = requireHarness('jsdom')
const dom = new JSDOM('<div data-slot="conversation"><div class="bt-bubble" data-reply-hold="space"><p>Reply text <a href="https://example.com">link</a></p><button>copy</button><pre><code>sample</code></pre><input><img><span data-file-path="fixture">attachment</span><details><summary>expand</summary></details><div class="bt-q">question</div></div></div>')
const { window } = dom
window.Range.prototype.getClientRects = () => [{ left: 20, right: 180, top: 20, bottom: 42, width: 160, height: 22 }]
const effects = []
const react = { createContext: value => ({ value }), useContext: context => context.value, useCallback: fn => fn, useSyncExternalStore: (_sub, get) => get(), createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'), useEffect: effect => effects.push(effect), useLayoutEffect: effect => effects.push(effect), useMemo: fn => fn(), useState: value => [typeof value === 'function' ? value() : value, () => {}], useRef: current => ({ current }) }
const { outputFiles } = await build({ stdin: { contents: "export * from './src/client/long-press-reply.js'; export * from './src/client/live-status.js'; export {Bubbles} from './src/client/cells.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : {}, window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement, Intl, Date, setTimeout, clearTimeout, setInterval, clearInterval, URL, console })
const { createReplyHold, replySpace, consumeReplyClick, useReplyHold, conversationStatus, useConversationStatus, Bubbles } = module.exports
const root = window.document.querySelector('.bt-bubble')
function fixture() {
  let time = 0, sequence = 0
  const timers = new Map(), calls = []
  const ctrl = createReplyHold({ reply: () => calls.push('quote'), now: () => time, schedule: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: time + delay }); return id }, unschedule: id => timers.delete(id) })
  const event = (extra = {}) => ({ currentTarget: root, target: root, pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, clientX: 5, clientY: 5, ...extra })
  const advance = amount => { time += amount; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn() } }
  return { ctrl, event, advance, calls, timers }
}
test('a short tap and mouse/pen holds retain the original behavior', () => {
  for (const type of ['touch', 'mouse', 'pen']) {
    const f = fixture(); f.ctrl.handlers.onPointerDown(f.event({ pointerType: type })); f.advance(200); f.ctrl.handlers.onPointerUp(f.event({ pointerType: type })); f.advance(1000); assert.equal(f.calls.length, 0); f.ctrl.dispose()
  }
})
test('one 520ms touch hold quotes directly once, and a separate second hold can quote again', () => {
  const f = fixture(); f.ctrl.handlers.onPointerDown(f.event()); f.advance(519); assert.equal(f.calls.length, 0); f.advance(1); assert.equal(f.calls.length, 1); f.advance(2000); assert.equal(f.calls.length, 1); f.ctrl.handlers.onPointerUp(f.event()); f.ctrl.handlers.onPointerDown(f.event()); f.advance(520); assert.equal(f.calls.length, 2); f.ctrl.dispose()
})
test('movement, pointer cancellation, lost capture, scroll and unmount cancel a pending hold', () => {
  const cancels = [f => f.ctrl.handlers.onPointerMove(f.event({ clientX: 30 })), f => f.ctrl.handlers.onPointerCancel(f.event()), f => f.ctrl.handlers.onLostPointerCapture(f.event()), () => root.ownerDocument.dispatchEvent(new window.Event('scroll')), f => f.ctrl.dispose()]
  for (const cancel of cancels) { const f = fixture(); f.ctrl.handlers.onPointerDown(f.event()); f.advance(250); cancel(f); f.advance(1000); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0); f.ctrl.dispose() }
})
test('a second finger cancels the first hold and does not arm another one', () => {
  const f = fixture(); f.ctrl.handlers.onPointerDown(f.event()); const other = new window.Event('pointerdown'); Object.defineProperty(other, 'pointerId', { value: 2 }); root.ownerDocument.dispatchEvent(other); f.ctrl.handlers.onPointerDown(f.event({ pointerId: 2, isPrimary: false })); f.advance(1000); assert.equal(f.calls.length, 0); f.ctrl.dispose()
})
test('links, buttons, code, inputs, attachments and cards do not trigger quotes', () => {
  for (const selector of ['a', 'button', 'code', 'input', 'img', '[data-file-path]', 'summary', '.bt-q']) { const f = fixture(); f.ctrl.handlers.onPointerDown(f.event({ target: root.querySelector(selector) })); f.advance(1000); assert.equal(f.calls.length, 0, selector); f.ctrl.dispose() }
})
test('text itself retains native selection; padding inside an outer slot is eligible', () => {
  assert.equal(replySpace(root, root.querySelector('p'), 40, 30), false)
  assert.equal(replySpace(root, root, 5, 5), true)
  const selection = window.getSelection(); const range = window.document.createRange(); range.selectNodeContents(root.querySelector('p')); selection.addRange(range)
  assert.equal(replySpace(root, root, 5, 5), false); selection.removeAllRanges()
})
test('new text selection cancels a hold instead of racing the native copy interaction', () => {
  const f = fixture(); f.ctrl.handlers.onPointerDown(f.event()); const range = window.document.createRange(); range.selectNodeContents(root.querySelector('p')); window.getSelection().addRange(range); window.document.dispatchEvent(new window.Event('selectionchange')); f.advance(1000); assert.equal(f.calls.length, 0); window.getSelection().removeAllRanges(); f.ctrl.dispose()
})
test('only eligible touch callouts are prevented; desktop and text context menus remain native', () => {
  const f = fixture(); let prevented = 0
  f.ctrl.handlers.onContextMenu(f.event({ preventDefault: () => prevented++ })); assert.equal(prevented, 0)
  f.ctrl.handlers.onPointerDown(f.event()); f.ctrl.handlers.onContextMenu(f.event({ preventDefault: () => prevented++ })); assert.equal(prevented, 1)
  f.ctrl.handlers.onContextMenu(f.event({ target: root.querySelector('p'), clientX: 40, clientY: 30, preventDefault: () => prevented++ })); assert.equal(prevented, 1); f.ctrl.dispose()
})
test('the ghost click is consumed before mention navigation, not a keyboard action or fresh tap', () => {
  const f = fixture(); f.ctrl.handlers.onPointerDown(f.event()); f.advance(520); f.ctrl.handlers.onPointerUp(f.event()); let prevented = 0
  const click = { target: root.querySelector('p'), pointerType: 'touch', detail: 1, preventDefault: () => prevented++, stopPropagation() {} }
  assert.equal(consumeReplyClick({ ...click, pointerType: '', detail: 0 }), false)
  assert.equal(consumeReplyClick(click), true); assert.equal(prevented, 1); assert.equal(consumeReplyClick(click), false)
  f.ctrl.handlers.onPointerDown(f.event()); f.advance(520); f.ctrl.handlers.onPointerUp(f.event()); f.ctrl.handlers.onPointerDown(f.event({ target: root.querySelector('a') })); assert.equal(consumeReplyClick({ ...click, target: root.querySelector('a') }), false); f.ctrl.dispose()
})
test('the hook routes a held reply to the supplied group composer without sending anything', async () => {
  const calls = []
  const handlers = useReplyHold({ sessionId: 'room-current', text: 'Complete group reply', enabled: true, actions: { quote: (...args) => calls.push(args) } })
  const cleanup = effects.at(-1)()
  handlers.onPointerDown({ currentTarget: root, target: root, pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, clientX: 5, clientY: 5 })
  await new Promise(resolve => setTimeout(resolve, 550))
  handlers.onPointerUp({ pointerId: 1 })
  assert.deepEqual(calls, [['room-current', 'Complete group reply']])
  cleanup()
})
test('streaming replies and bubbles without a composer do not expose gesture handlers', () => {
  for (const input of [{ sessionId: 'room-current', enabled: false }, { sessionId: undefined, enabled: true }]) {
    const handlers = useReplyHold({ ...input, text: 'Reply', actions: { quote: () => { throw Error('not available') } } })
    assert.equal(Object.keys(handlers).length, 0)
    effects.at(-1)()()
  }
})
test('Bubbles keeps the group session and original text on the gesture-bearing Bubble', () => {
  const tree = Bubbles({ texts: ['Group reply'], roster: { bots: [], byId: { bot: { name: 'Bot' } } }, selfId: 'bot', sessionId: 'room-current', actions: {}, picked: [] })
  const bubble = tree.props.children[0][0]
  assert.equal(bubble.props.sessionId, 'room-current'); assert.equal(bubble.props.text, 'Group reply')
})

const a = { id: 'a', name: 'Alice', sessionId: 'a-current' }, b = { id: 'b', name: 'Bob', sessionId: 'b-current' }
const room = { id: 'g', name: 'Group', sessionId: 'g-current', members: ['a', 'b'] }
const roster = { ready: true, byId: { a, 'a-old': a, 'a-current': a, b, 'b-current': b }, roomsById: { g: room, 'g-current': room }, questions: {}, views: {} }
const status = (extra = {}) => conversationStatus({ sessionId: 'a', roster, ...extra })
test('idle ignores stale activity, history and settled user cards', () => {
  assert.equal(status({ activity: 'working' }).text, 'Idle')
  assert.equal(status({ roster: { ...roster, questions: { 'a-current': { outcome: 'answered' } }, views: { 'a-current': { status: 'done' } } } }).text, 'Idle')
})
test('live own work uses concrete doing and valid user waits retain priority', () => {
  const work = { bots: { a: { tool: 'read', note: 'Read current source' } }, approvals: [] }
  assert.equal(status({ work }).text, 'Read current source…')
  assert.equal(status({ work: { ...work, approvals: [{ botId: 'a' }] } }).kind, 'approval')
  assert.equal(status({ work, roster: { ...roster, questions: { 'a-current': {} } } }).kind, 'answer')
})
test('group work and real handoff waits show current names without fake percentages', () => {
  assert.match(status({ work: { rooms: { g: [{ botId: 'a', tool: 'read' }] } } }).text, /^Group · /)
  assert.equal(status({ work: { waiting: { a: { bots: ['b'], rooms: ['g'] } } } }).text, 'Waiting for Bob and Group')
  assert.equal(status({ work: { waiting: { a: { bots: ['gone'] } } } }).text, 'Idle')
})
test('only explicit persistent blocking metadata shows an attention state', () => {
  const blocked = { ...a, blocked: { code: 'AUTH_ERROR' } }
  assert.equal(status({ roster: { ...roster, byId: { ...roster.byId, a: blocked } } }).kind, 'blocked')
  assert.equal(status({ roster: { ...roster, byId: { ...roster.byId, a: blocked } }, running: true }).kind, 'working')
})
test('group header uses only this group, reflects multiple workers and ignores other-chat approvals', () => {
  const group = extra => conversationStatus({ sessionId: 'g', roster, ...extra })
  assert.equal(group({ work: { rooms: { other: [{ botId: 'a' }] }, approvals: [{ botId: 'a', roomId: 'other' }] } }).text, 'Idle')
  assert.match(group({ work: { rooms: { g: [{ botId: 'a', note: 'Read' }, { botId: 'b', note: 'Check' }] } } }).text, /^2 Bots working/)
  assert.equal(group({ work: { approvals: [{ botId: 'b', roomId: 'g' }] } }).kind, 'approval')
})
test('session switches and old-part views derive fresh status from the current owner part', () => {
  const make = (sessionId, map, work) => useConversationStatus({ sessionId, roster, useSessionStatus: pick => pick(map), useWork: pick => pick(work), useActivity: pick => pick({ a: 'working' }) })
  assert.equal(make('a-old', new Map([['a-old', { running: true }]]), {}).kind, 'idle')
  assert.equal(make('a-old', new Map([['a-current', { running: true }]]), {}).kind, 'working')
  assert.equal(make('b', new Map(), { waiting: { a: { bots: ['b'] } } }).kind, 'idle')
})
