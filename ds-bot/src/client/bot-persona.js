import { createElement as h, useEffect, useState } from 'react'
import { defaultPersona, editablePersona, promptMode } from '../shared/bot-persona.js'
import { t } from './i18n.js'

// Keep unfinished edits when settings close or another Bot is selected. Nothing is
// written to browser storage; only an explicit Save changes the Bot.
const drafts = new Map()
if (typeof window !== 'undefined') window.addEventListener?.('beforeunload', event => {
  if (drafts.size === 0) return
  event.preventDefault()
  event.returnValue = ''
})
const profile = bot => ({ promptMode: promptMode(bot), instructions: bot.instructions ?? '', systemPrompt: bot.systemPrompt ?? '' })
const fingerprint = bot => JSON.stringify(profile(bot))
const fresh = bot => ({ ...profile(bot), base: fingerprint(bot) })

export function BotPersonaCard({ bot, main, actions, Card }) {
  const [draft, setDraft] = useState(() => drafts.get(bot.id) ?? fresh(bot))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(false)
  const current = fingerprint(bot)
  const dirty = JSON.stringify(profile(draft)) !== draft.base
  const conflict = dirty && current !== draft.base
  useEffect(() => {
    if (!dirty) setDraft(fresh(bot))
  }, [current])
  useEffect(() => {
    if (dirty) drafts.set(bot.id, draft)
    else drafts.delete(bot.id)
  }, [bot.id, draft, dirty])
  const change = patch => { setDraft(value => ({ ...value, ...patch })); setError('') }
  const cancel = () => { drafts.delete(bot.id); setDraft(fresh(bot)); setError('') }
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const normalized = { ...profile(draft), instructions: draft.instructions.trim(), systemPrompt: draft.systemPrompt.trim() }
      await actions.updateBot(bot.id, { ...normalized, promptExpected: draft.base })
      drafts.delete(bot.id)
      setDraft({ ...normalized, base: fingerprint(normalized) })
    } catch (cause) {
      setError(cause?.message ?? String(cause))
    } finally { setBusy(false) }
  }
  return h(Card, { title: t('System prompt') },
    h('div', { className: 'bt-persona' },
      h('p', { className: 'bt-set-hint' }, t('Manage this Bot’s persona, voice and working strategy.')),
      h('label', { className: 'bt-bs-label' }, t('Prompt mode'),
        h('select', { className: 'bt-persona-mode', value: draft.promptMode, disabled: busy, onChange: event => change({ promptMode: event.target.value }) },
          [['default', 'Product default'], ['append', 'Default + additional instructions'], ['replace', 'Custom system prompt']].map(([value, label]) => h('option', { key: value, value }, t(label))))),
      draft.promptMode === 'append' ? h('textarea', { className: 'bt-persona-text', 'aria-label': t('Additional instructions'), value: draft.instructions, disabled: busy, rows: 10, onChange: event => change({ instructions: event.target.value }) }) : null,
      draft.promptMode === 'replace' ? h('textarea', { className: 'bt-persona-text', 'aria-label': t('Custom system prompt'), value: draft.systemPrompt, disabled: busy, rows: 14, maxLength: 50000, placeholder: t('Describe the complete persona, voice and working strategy…'), onChange: event => change({ systemPrompt: event.target.value }) }) : null,
      draft.promptMode === 'replace' && !draft.systemPrompt.trim() ? h('p', { className: 'bt-set-hint' }, t('A custom prompt cannot be empty. Choose Product default to restore defaults.')) : null,
      h('p', { className: 'bt-set-hint' }, t('Custom mode replaces the product’s default persona and style. Team routing, tools, memory, host and provider instructions, and permissions remain in effect.')),
      h('p', { className: 'bt-set-hint' }, t('Saved changes apply when the next model request is assembled, including group chats. An in-flight response keeps its current prompt; previous conversation history remains.')),
      h('div', { className: 'bt-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => change({ promptMode: 'default' }) }, t('Restore product default')),
        draft.promptMode === 'replace' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || Boolean(draft.systemPrompt), onClick: () => change({ systemPrompt: defaultPersona(main) }) }, t('Start from default template')) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': preview, onClick: () => setPreview(value => !value) }, t('Preview editable layer'))),
      preview ? h('div', null,
        h('p', { className: 'bt-set-hint' }, t('Draft preview: only the editable product layer, not the full model prompt.')),
        h('pre', { className: 'bt-persona-preview' }, editablePersona(draft, main))) : null,
      dirty ? h('p', { className: 'bt-set-hint', role: 'status' }, t('Unsaved draft kept while switching settings. Save to apply, or Cancel to discard.')) : null,
      conflict ? h('p', { role: 'alert' }, t('This Bot’s prompt changed elsewhere. Cancel to load the saved version before editing again.')) : null,
      error ? h('p', { role: 'alert' }, error) : null,
      h('div', { className: 'bt-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !dirty || busy || conflict || (draft.promptMode === 'replace' && !draft.systemPrompt.trim()), onClick: save }, t(busy ? 'Saving…' : 'Save')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !dirty || busy, onClick: cancel }, t('Cancel')))))
}

export const BOT_PERSONA_CSS = `
.bt-persona{display:flex;flex-direction:column;gap:12px;padding:16px}
.bt-persona p{margin:0}
.bt-persona-mode{display:block;width:100%;margin-top:8px;padding:8px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit}
.bt-persona-text{box-sizing:border-box;width:100%;resize:vertical;min-height:180px;border:1px solid var(--bt-line);border-radius:8px;padding:12px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:14px;line-height:22px}
.bt-persona-text:focus,.bt-persona-mode:focus{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-persona-preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;font:inherit;font-size:13px;line-height:18px;background:var(--bt-card);border:1px solid var(--bt-line);border-radius:8px;padding:12px}
.bt-persona [role=alert]{color:var(--bt-danger);font-size:12px}
.bt-persona .bt-actions{flex-wrap:wrap}
`
