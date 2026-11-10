import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
const { outputFiles } = await build({
  stdin: { contents: "export { BotPersonaCard } from './src/client/bot-persona.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react'],
})
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
const react = {
  Fragment: 'fragment',
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useMemo: make => make(),
  useCallback: fn => fn,
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useId: () => slot(() => ({ id: 'card-id' })).id,
  useEffect: effect, useLayoutEffect: effect,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
const { BotPersonaCard } = module.exports
const mount = (Component, props) => {
  const instance = {
    slots: [], effects: [], props,
    render(next = instance.props) {
      instance.props = next
      instance.index = 0
      current = instance
      const out = Component(next)
      current = undefined
      for (const run of instance.effects.splice(0)) run()
      return out
    },
    unmount() { for (const cell of instance.slots) cell.stop?.() },
  }
  return instance
}
const find = (node, check) => {
  if (Array.isArray(node)) return node.map(child => find(child, check)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return check(node) ? node : find(node.props.children, check)
}

const button = (tree, text) => find(tree, node => node.type === 'button' && node.props.children.includes(text))
const field = tree => find(tree, node => node.type === 'textarea')
const mode = tree => find(tree, node => node.type === 'select')

test('persona editor keeps drafts across unmount, cancels, and only saves explicitly', async () => {
  let saved = 0
  const props = { bot: { id: 'editor-one', instructions: 'Old task' }, Card: 'section', actions: { updateBot: async () => { saved++ } } }
  let editor = mount(BotPersonaCard, props)
  let tree = editor.render()
  mode(tree).props.onChange({ target: { value: 'replace' } })
  tree = editor.render()
  assert.equal(button(tree, 'Save').props.disabled, true)
  field(tree).props.onChange({ target: { value: 'New persona' } })
  tree = editor.render()
  assert.equal(saved, 0)
  editor.unmount()
  editor = mount(BotPersonaCard, props)
  tree = editor.render()
  assert.equal(field(tree).props.value, 'New persona')
  button(tree, 'Cancel').props.onClick()
  tree = editor.render()
  assert.equal(mode(tree).props.value, 'append')
  assert.equal(field(tree).props.value, 'Old task')
  assert.equal(button(tree, 'Save').props.disabled, true)
  field(tree).props.onChange({ target: { value: '  Updated task  ' } })
  tree = editor.render()
  await button(tree, 'Save').props.onClick()
  tree = editor.render()
  assert.equal(saved, 1)
  assert.equal(field(tree).props.value, 'Updated task')
  assert.equal(button(tree, 'Save').props.disabled, true)
})

test('failed save retains draft and concurrent update blocks overwriting', async () => {
  const props = { bot: { id: 'editor-two', promptMode: 'replace', systemPrompt: 'Saved' }, Card: 'section', actions: { updateBot: async () => { throw new Error('Offline') } } }
  const editor = mount(BotPersonaCard, props)
  let tree = editor.render()
  field(tree).props.onChange({ target: { value: 'Keep this draft' } })
  tree = editor.render()
  await button(tree, 'Save').props.onClick()
  tree = editor.render()
  assert.equal(field(tree).props.value, 'Keep this draft')
  assert.ok(find(tree, node => node.props.role === 'alert' && node.props.children.includes('Offline')))
  tree = editor.render({ ...props, bot: { ...props.bot, systemPrompt: 'Changed elsewhere' } })
  assert.equal(button(tree, 'Save').props.disabled, true)
  button(tree, 'Cancel').props.onClick()
  tree = editor.render()
  assert.equal(field(tree).props.value, 'Changed elsewhere')
})
