import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settingsGroups } from '../src/client/mobile-settings-model.js'

test('settings home groups only pages the current host actually supplies', () => {
  const groups = settingsGroups([['general', 'General'], ['notifications', 'Phone notifications (trial)'], ['bots', 'Bots'], ['connectors', 'Connectors'], ['about', 'About DS Bot']])
  assert.deepEqual(groups.map(group => group.label), ['General', 'Bots', 'Capabilities', 'More'])
  assert.deepEqual(groups.flatMap(group => group.rows.map(row => row.id)), ['general', 'notifications', 'bots', 'connectors', 'about'])
  assert.equal(groups.some(group => group.rows.some(row => row.id === 'models')), false)
})

test('registered host settings keep their own action and do not require an invented web endpoint', () => {
  let called = false
  const open = () => { called = true }
  const groups = settingsGroups([['general', 'General']], [{ id: 'dsh:fixture', label: 'Fixture host page', open }])
  assert.deepEqual(groups.map(group => group.label), ['General', 'More'])
  groups[1].rows[0].open()
  assert.equal(called, true)
  assert.equal(groups[1].rows[0].id, 'dsh:fixture')
})

test('existing web settings capabilities remain reachable exactly once in the grouped home', () => {
  const ids = ['general', 'notifications', 'models', 'bots', 'groups', 'bot-models', 'local-agents', 'schedules', 'connectors', 'capabilities', 'browser', 'computer', 'im', 'secrets', 'phone', 'usage', 'feedback', 'about']
  const found = settingsGroups(ids.map(id => [id, id])).flatMap(group => group.rows.map(row => row.id))
  assert.equal(new Set(found).size, ids.length)
  assert.deepEqual([...found].sort(), [...ids].sort())
})
