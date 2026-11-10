import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TASK_AUTHORIZATION } from '../src/shared/task-authorization.js'
import { systemPrompt as refsPolicy } from '../src/host/browser/refs.js'
import { systemPrompt as scriptPolicy } from '../src/host/browser/script.js'
import { systemPrompt as taskPolicy } from '../src/host/browser/task.js'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function start(delegated = false) {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
    isFullyDelegated: id => delegated && ['main', 'worker', 'group-worker'].includes(id),
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt, bots }
}

test('Bots get a scoped progress rule without changing the private/group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
  ]
  for (const id of ['main', 'worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

test('full delegation covers every task while questions remain about user intent', (t) => {
  const { ctx, prompt } = start(true)
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker', 'group-worker']) {
    assert.match(prompt(id), /for all tasks, including direct requests, group work and scheduled tasks/)
    assert.match(prompt(id), /without asking for execution permission/)
    assert.match(prompt(id), /ask_user only when their intent or a necessary decision is missing/)
  }
  assert.doesNotMatch(prompt('room'), /fully delegated/)
})


test('custom persona replaces product style without removing identity and routing', async (t) => {
  const { ctx, prompt, bots } = start()
  t.after(() => ctx.dispose())
  const legacy = prompt('worker')
  bots.get('worker').promptMode = 'append'
  assert.equal(prompt('worker'), legacy)
  Object.assign(bots.get('worker'), { promptMode: 'replace', systemPrompt: 'Write long formal paragraphs with headings.' })
  assert.match(prompt('worker'), /Write long formal paragraphs/)
  assert.doesNotMatch(prompt('worker'), /Check files|Chat like a teammate|Only for a direct user request|Offer choices/)
  assert.match(prompt('worker'), /You are Dev/)
  assert.match(prompt('worker'), /Only a Main Bot can change other Bots/)
  assert.equal(prompt('worker'), prompt('group-worker'))
  Object.assign(bots.get('main'), { promptMode: 'replace', systemPrompt: 'Do the work yourself unless asked to delegate.' })
  assert.doesNotMatch(prompt('main'), /Route work to the right Bot|When the user wants something that deserves/)
  bots.get('worker').promptMode = 'default'
  assert.match(prompt('worker'), /Chat like a teammate/)
  assert.doesNotMatch(prompt('worker'), /Check files|Write long formal paragraphs/)
  bots.get('worker').promptMode = 'append'
  assert.equal(prompt('worker'), legacy)
})


for (const mode of ['default', 'append', 'replace']) {
  test(`global task authorization reaches ${mode} persona without modifying user text`, (t) => {
    const { ctx, prompt, bots } = start()
    t.after(() => ctx.dispose())
    const custom = 'Keep my existing custom voice and instructions.'
    Object.assign(bots.get('worker'), { promptMode: mode, instructions: 'Existing task note.', systemPrompt: custom })
    const before = JSON.stringify(bots.get('worker'))
    const text = prompt('worker')
    assert.equal(text.split(TASK_AUTHORIZATION).length - 1, 1)
    assert.equal(prompt('group-worker'), text)
    assert.match(text, /specific action, execute it without asking/)
    assert.match(text, /new goal, recipient, deletion scope, cost or security boundary/)
    assert.match(text, /mandatory host\/provider instructions, tool approvals, permissions and safety boundaries still apply/)
    assert.match(text, /Never approve on the user’s behalf, auto-approve after a timeout, bypass an approval/)
    assert.match(text, /A missing decision blocks only work that depends on it/)
    assert.equal(JSON.stringify(bots.get('worker')), before)
    if (mode === 'replace') assert.ok(text.includes(custom))
  })
}

test('all nested browser policies receive the same authorization boundary and retain tool restrictions', () => {
  for (const text of [refsPolicy, scriptPolicy, taskPolicy]) {
    assert.ok(text.includes(TASK_AUTHORIZATION))
    assert.match(text, /second confirmed click/)
    assert.match(text, /Payments, logins, and captchas/)
  }
})

test('team coordination favors direct small tasks and actual completion evidence', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('main'), /Do small, self-contained tasks directly/)
  assert.match(prompt('worker'), /Reuse that observed roster within the task/)
  assert.match(prompt('worker'), /waiting panel or lifecycle message is not completion evidence/)
})
