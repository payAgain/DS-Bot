const GROUPS = [
  ['General', ['general', 'notifications']],
  ['Bots', ['models', 'bots', 'groups', 'bot-models', 'local-agents', 'schedules']],
  ['Capabilities', ['connectors', 'capabilities', 'browser', 'computer', 'im', 'secrets']],
  ['More', ['phone', 'usage', 'feedback', 'about']],
]
export function settingsGroups(pages, extra = []) {
  const available = new Map(pages)
  return GROUPS.map(([label, ids]) => ({ label, rows: ids.filter(id => available.has(id)).map(id => ({ id, label: available.get(id) })) }))
    .map(group => group.label === 'More' ? { ...group, rows: [...group.rows, ...extra] } : group)
    .filter(group => group.rows.length > 0)
}
