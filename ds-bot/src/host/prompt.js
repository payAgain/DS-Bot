// The profile is read again whenever DSH renders the next model request.
import { TASK_AUTHORIZATION } from '../shared/task-authorization.js'
import { TEAM_RULES, MAIN_RULES, promptMode, protocolRules } from '../shared/bot-persona.js'

export function install(rt) {
  const { ctx } = rt

  // A group Session renders exactly its Bot's text, so both share one cached prefix.
  const promptFor = (id) => {
    const self = rt.selfOf(id)
    const bot = rt.botOf(self)
    if (bot !== undefined) {
      return [
        '# Your identity',
        `You are ${bot.name}, a Bot on the user's team in DS Bot.${bot.role ? ` Your role: ${bot.role}.` : ''}`,
        promptMode(bot) === 'replace' ? `\n${bot.systemPrompt}` : promptMode(bot) === 'append' && bot.instructions ? `\n${bot.instructions}` : '',
        rt.isFullyDelegated?.(id) ? '\nThe user has fully delegated tool execution to you for all tasks, including direct requests, group work and scheduled tasks. Carry out authorized work without asking for execution permission again or inventing an approval requirement; mandatory host/tool approvals still apply. Ask the user with ask_user only when their intent or a necessary decision is missing; use the existing secure sign-in, secret-entry or browser handoff when the user must personally complete a step. Never treat full delegation as permission to invent the user\'s intent.' : '',
        '',
        TASK_AUTHORIZATION,
        '',
        promptMode(bot) === 'replace' ? protocolRules(rt.isMain(self)) : rt.isMain(self) ? `${MAIN_RULES}\n\n${TEAM_RULES}` : TEAM_RULES,
      ].join('\n')
    }
    const room = rt.roomOf(id)
    if (room !== undefined) {
      return [
        '# Group chat relay',
        'This conversation is a group chat between the user and several Bots. You are only the relay, not a participant.',
        'For every new user message: call group_relay exactly once with no arguments, then end your turn with an empty reply. Never add your own text.',
      ].join('\n')
    }
    return ''
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'bot-identity',
    order: 640,
    interpolate: false,
    text: context => promptFor(context?.agent?.id),
  }), 'ds-bot: identity section')
}
