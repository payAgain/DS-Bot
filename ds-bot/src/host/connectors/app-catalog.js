// Product names and toolkit slugs follow OpenMausBot's Apache-2.0 catalog.
// Attribution and the source revision are recorded in NOTICE.
export const CURATED_APPS = [
  ['slack', 'Slack'], ['github', 'GitHub'], ['gmail', 'Gmail'], ['googlecalendar', 'Google Calendar'],
  ['googlesheets', 'Google Sheets'], ['googledocs', 'Google Docs'], ['googledrive', 'Google Drive'],
  ['notion', 'Notion'], ['linear', 'Linear'], ['sentry', 'Sentry'], ['posthog', 'PostHog'],
  ['discord', 'Discord'], ['twitter', 'X (Twitter)'], ['reddit', 'Reddit'], ['zapier', 'Zapier'],
  ['hubspot', 'HubSpot'], ['salesforce', 'Salesforce'], ['jira', 'Jira'], ['asana', 'Asana'],
  ['trello', 'Trello'], ['dropbox', 'Dropbox'], ['airtable', 'Airtable'], ['figma', 'Figma'], ['stripe', 'Stripe'],
].map(([slug, name]) => ({ slug, name, noAuth: false }))

export function appCatalogPage(items, { query = '', cursor = '' } = {}) {
  const needle = query.trim().toLowerCase()
  const matches = items.filter(item => !needle || `${item.name} ${item.slug} ${item.description ?? ''}`.toLowerCase().includes(needle))
  const offset = /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0
  const next = offset + 40
  return { items: matches.slice(offset, next), cursor: next < matches.length ? String(next) : null }
}
