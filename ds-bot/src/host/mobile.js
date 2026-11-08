const fail = (message, code = 'invalid') => { throw Object.assign(new Error(message), { code: `bot/${code}` }) }
const requestName = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(value)

export function install(rt) {
  const target = body => {
    const bot = rt.botOf(body.conversationId)
    if (bot && rt.chatOf(bot.id) === body.expectedSessionId) return body.expectedSessionId
    const room = rt.roomOf(body.conversationId)
    if (room && rt.sessionOfRoom(room) === body.expectedSessionId
      && JSON.stringify(room.members) === JSON.stringify(body.expectedMembers)) return body.expectedSessionId
    fail('The mobile conversation changed. Refresh it before continuing.', 'stale')
  }
  const identity = (body, content) => rt.requestIdentity({ caller: 'mobile', context: body.conversationId,
    name: body.requestId, payload: { sessionId: body.expectedSessionId, content } })
  const contentOf = body => {
    if (!Array.isArray(body.content) || !body.content.length || body.content.length > 9) fail('Send text and at most eight attachments.')
    let images = 0, bytes = 0, textLength = 0
    return body.content.map(part => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        textLength += part.text.length
        if (textLength > 100000 || part.text.includes('dsh-session:')) fail('The mobile message is too long or contains an unsupported Session reference.')
        return { type: 'text', text: part.text }
      }
      if (!['image', 'file'].includes(part?.type) || typeof part.attachment?.attachmentId !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(part.attachment.attachmentId)
        || !Number.isSafeInteger(part.attachment.bytes) || part.attachment.bytes < 0) fail('Invalid mobile attachment.')
      images++
      bytes += part.attachment.bytes
      if (images > 8 || bytes > 20 * 1024 * 1024) fail('The mobile attachments exceed the message limit.')
      return { type: part.type, attachment: part.attachment }
    })
  }
  rt.mobileEndpoint = async (endpoint, body, signal) => {
    if (endpoint === 'mobile-describe') return { version: 1, stableRequestId: true, prepareCapabilities: true, attachments: true }
    await rt.load()
    const sessionId = target(body)
    if (!requestName(body.requestId)) fail('Invalid mobile request identity.')
    if (endpoint === 'mobile-receipt') {
      const record = rt.own(rt.state.requests, identity(body, []).key)
      if (record?.outcome === 'delivered' && record.receipt?.accepted === true
        && record.receipt.sessionId === sessionId) return record.receipt
      return { accepted: false, status: 'unknown', requestId: body.requestId, sessionId }
    }
    if (endpoint !== 'mobile-submit') fail('Unknown mobile operation.')
    if (rt.readOnly()) fail('The team is read-only.', 'read-only')
    const content = contentOf(body)
    const result = await rt.admitRequest(identity(body, content), async () => {
      signal?.throwIfAborted()
      await rt.ensureCapabilities(sessionId)
      target(body)
      signal?.throwIfAborted()
      const admission = await rt.ctx.sessionController.prompt({ requestId: body.requestId, sessionId, mode: 'queue', content }, signal)
      if (admission?.accepted !== true) fail('The host did not confirm mobile message admission.', 'unconfirmed')
      return { accepted: true, requestId: body.requestId, sessionId }
    })
    if (result.status === 'conflict') fail('This mobile request was already used for different content.', 'conflict')
    if (!['sent', 'replay'].includes(result.status) || result.receipt?.accepted !== true) fail('The mobile receipt is uncertain. Check history before retrying.', 'unconfirmed')
    return result.receipt
  }
}
