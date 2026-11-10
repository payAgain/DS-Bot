import { createHash } from 'node:crypto'

// A description can change when a skill is applied, so it belongs in the approved
// version too. Do not discard headings or use semantic similarity as authorization.
export const skillVersion = value => createHash('sha256').update(JSON.stringify([
  String(value?.description ?? '').replace(/\r\n/g, '\n').trim(),
  String(value?.content ?? '').replace(/\r\n/g, '\n').trim(),
])).digest('hex')

export function approvedSkills(skills, settled) {
  const result = new Map()
  for (const entry of Object.values(settled ?? {})) {
    if (entry.kind !== 'skill' || entry.outcome !== 'approved' || entry.retiredAt !== undefined) continue
    const current = Object.hasOwn(skills, entry.name) ? skills[entry.name] : undefined
    if (current?.createdAt > entry.settledAt) continue
    if (entry.capabilityCreatedAt !== undefined && current?.createdAt !== entry.capabilityCreatedAt) continue
    if (current?.kind === 'skill' && skillVersion(current) === skillVersion(entry)) result.set(current.name, { item: current, approval: entry })
  }
  return [...result.values()]
}

export function approvedMatch(proposal, skills, settled) {
  const version = skillVersion(proposal)
  return approvedSkills(skills, settled).find(({ item }) => skillVersion(item) === version)
}
