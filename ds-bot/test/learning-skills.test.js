import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvedMatch, approvedSkills, skillVersion } from '../src/host/learning-skills.js'

const skill = { name: 'checks', kind: 'skill', description: 'When checking work.', content: '# Rules\nReview the result.', createdAt: 10 }
const receipt = { id: 'approved', ...skill, outcome: 'approved', settledAt: 20, capabilityCreatedAt: 10 }

test('approved definitions are exact versions, including scope-bearing descriptions', () => {
  assert.equal(skillVersion(skill), skillVersion({ ...skill, name: 'other-name', content: '# Rules\r\nReview the result.\n' }))
  assert.notEqual(skillVersion(skill), skillVersion({ ...skill, description: 'Always perform work.' }))
  assert.notEqual(skillVersion(skill), skillVersion({ ...skill, content: skill.content + '\nRun another command.' }))
  assert.notEqual(skillVersion(skill), skillVersion({ ...skill, content: '# Different instructions\nReview the result.' }))
})

test('a known name or similar wording cannot authorize an unapproved or edited version', () => {
  assert.equal(approvedMatch(skill, { checks: skill }, {}), undefined)
  assert.equal(approvedMatch({ ...skill, content: skill.content + '\nExtra.' }, { checks: skill }, { approved: receipt }), undefined)
  assert.equal(approvedMatch(skill, { checks: { ...skill, content: 'Edited outside this approval.' } }, { approved: receipt }), undefined)
  assert.equal(approvedMatch(skill, { checks: skill }, { approved: { ...receipt, outcome: 'declined' } }), undefined)
  assert.equal(approvedMatch(skill, { checks: skill }, { approved: { ...receipt, retiredAt: 30 } }), undefined)
})

test('deleted/recreated skills do not inherit the old object approval', () => {
  assert.deepEqual(approvedSkills({ checks: { ...skill, createdAt: 30 } }, { approved: receipt }), [])
  assert.equal(approvedMatch({ ...skill, name: 'another-name' }, { checks: skill }, { approved: receipt })?.approval.id, 'approved')
})
