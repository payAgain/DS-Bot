import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'

test('task helper labels and status names are translated, including dynamic form copy', () => {
  const source = readFileSync(new URL('../src/client/task-workbench.js', import.meta.url), 'utf8')
  const labels = [...source.matchAll(/\b(?:button|field|t)\('([^']+)'/g)].map(match => match[1])
  labels.push('To plan', 'In progress', 'Waiting', 'To review', 'Completed', 'Cancelled', 'New task', 'Edit task', 'Last day (inclusive)', 'End', 'Personal', 'Bot work', 'Me', 'Former Bot', 'Loading…', 'Saving…')
  for (const [locale, dictionary] of Object.entries(DICTIONARY)) {
    if (locale === 'en') continue
    for (const label of labels) assert.equal(typeof dictionary[label], 'string', `${locale}: ${label}`)
  }
})
