import { randomBytes, createHmac, timingSafeEqual, createECDH } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod, stat, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import webpush from 'web-push'
import { replaceFile } from './files.js'
import { pushError, pushHash, pushAgent, validatePushSubscription, validTarget } from './web-push-policy.js'

const MAX_DEVICES = 32
const MAX_QUEUE = 64
const MAX_SEEN = 2048
const TTL = 3600
const subject = 'https://github.com/Fei2411/DS-Bot'

// Transport state belongs to this feature, never to the chat/schedule stores.
export class WebPushStore {
  constructor({ directory, writable, targetAllowed, send = (...args) => webpush.sendNotification(...args), now = Date.now }) {
    Object.assign(this, { directory, writable, targetAllowed, send, now })
    this.agent = pushAgent()
    this.data = { version: 1, devices: {}, queue: [], seen: {} }
    this.serial = Promise.resolve()
    this.stopped = false
    this.active = false
  }
  async init() {
    this.checkWritable()
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.directory)
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw pushError('push/storage', 503)
    for (const name of ['vapid.json', 'devices.json']) {
      try {
        const entry = await lstat(join(this.directory, name))
        if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 1024 * 1024) throw pushError('push/storage', 503)
      } catch (error) { if (error.code !== 'ENOENT') throw pushError('push/storage', 503) }
    }
    await chmod(this.directory, 0o700)
    try { this.keys = JSON.parse(await readFile(join(this.directory, 'vapid.json'), 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw pushError('push/storage', 503)
      try {
        await stat(join(this.directory, 'devices.json'))
        throw pushError('push/storage', 503)
      } catch (existing) { if (existing.code !== 'ENOENT') throw pushError('push/storage', 503) }
      this.keys = webpush.generateVAPIDKeys()
      await this.atomic('vapid.json', this.keys)
    }
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(this.keys?.privateKey) || !/^[A-Za-z0-9_-]{87}$/.test(this.keys?.publicKey)) throw new Error('invalid')
      const key = createECDH('prime256v1'); key.setPrivateKey(Buffer.from(this.keys.privateKey, 'base64url'))
      if (key.getPublicKey().toString('base64url') !== this.keys.publicKey) throw new Error('invalid')
    } catch { throw pushError('push/storage', 503) }
    await chmod(join(this.directory, 'vapid.json'), 0o600)
    try { this.data = JSON.parse(await readFile(join(this.directory, 'devices.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw pushError('push/storage', 503) }
    if (this.data?.version !== 1 || !this.data.devices || !Array.isArray(this.data.queue) || !this.data.seen) throw pushError('push/storage', 503)
    // An interrupted send may already have been accepted. Never replay it blindly.
    this.data.queue = this.data.queue.filter(job => job.state === 'queued' && job.expires > this.now()).slice(0, MAX_QUEUE)
    await this.save()
    this.drain()
    return this
  }
  checkWritable() { if (this.stopped || !this.writable()) throw pushError('push/unavailable', 503) }
  async atomic(name, value) {
    this.checkWritable()
    const path = join(this.directory, name), temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await replaceFile(temp, path, () => this.checkWritable())
    await chmod(path, 0o600)
  }
  save() { return this.atomic('devices.json', this.data) }
  mutate(run) {
    const next = this.serial.then(async () => { this.checkWritable(); return run() })
    this.serial = next.catch(() => {})
    return next
  }
  csrf(cookie) { return createHmac('sha256', this.keys.privateKey).update(`dsbot-webpush-csrf-v1:${cookie}`).digest('base64url') }
  checkCsrf(cookie, token) {
    const expected = Buffer.from(this.csrf(cookie)), provided = Buffer.from(typeof token === 'string' ? token : '')
    return expected.length === provided.length && timingSafeEqual(expected, provided)
  }
  status(owner) {
    const device = this.data.devices[owner]
    return { subscribed: Boolean(device), includePrivate: device?.includePrivate === true, lastTest: device?.lastTest ?? null }
  }
  subscribe(owner, value, { includePrivate = false, language = 'en' } = {}) {
    return this.mutate(async () => {
      const subscription = validatePushSubscription(value)
      const fingerprint = pushHash(subscription.endpoint)
      if (Object.entries(this.data.devices).some(([id, device]) => id !== owner && device.fingerprint === fingerprint)) throw pushError('push/owned-elsewhere', 409)
      if (!this.data.devices[owner] && Object.keys(this.data.devices).length >= MAX_DEVICES) throw pushError('push/device-limit', 429)
      this.data.devices[owner] = { subscription, fingerprint, includePrivate: includePrivate === true, language: String(language).startsWith('zh') ? 'zh' : 'en', at: this.now() }
      await this.save()
      return this.status(owner)
    })
  }
  unsubscribe(owner) {
    return this.mutate(async () => {
      delete this.data.devices[owner]
      this.data.queue = this.data.queue.filter(job => job.owner !== owner)
      await this.save()
      return { subscribed: false }
    })
  }
  async emit(key, kind, target, privateSource = false) {
    if (!validTarget(target) || !['reply', 'report', 'approval', 'answer', 'failure'].includes(kind) || Object.keys(this.data.devices).length === 0) return
    await this.mutate(async () => {
      for (const [owner, device] of Object.entries(this.data.devices)) {
        if ((!device.includePrivate && privateSource) || !this.targetAllowed(target, device)) continue
        this.enqueue(owner, key, kind, target, privateSource)
      }
      await this.save()
    })
    this.drain()
  }
  enqueue(owner, key, kind, target, privateSource = false) {
    const id = pushHash(`${owner}:${key}`).slice(0, 32)
    if (this.data.seen[id] || this.data.queue.length >= MAX_QUEUE) return false
    this.data.seen[id] = this.now()
    const entries = Object.entries(this.data.seen).sort((a, b) => a[1] - b[1])
    for (const [old] of entries.slice(0, Math.max(0, entries.length - MAX_SEEN))) delete this.data.seen[old]
    this.data.queue.push({ id, owner, kind, target, private: privateSource, expires: this.now() + TTL * 1000, state: 'queued', attempts: 0 })
    return true
  }
  async test(owner) {
    await this.mutate(async () => {
      const device = this.data.devices[owner]
      if (!device) throw pushError('push/not-subscribed', 409)
      if (device.lastTestAt !== undefined && this.now() - device.lastTestAt < 30_000) throw pushError('push/rate-limit', 429)
      if (!this.enqueue(owner, `test:${randomBytes(12).toString('hex')}`, 'test', '')) throw pushError('push/queue-limit', 429)
      device.lastTestAt = this.now()
      device.lastTest = { state: 'queued', at: this.now() }
      await this.save()
    })
    this.drain()
    return { state: 'queued' }
  }
  drain() {
    if (this.active || this.stopped) return
    this.active = true
    clearTimeout(this.timer)
    this.running = this.run().catch(() => {}).finally(() => {
      this.active = false
      if (!this.stopped && this.writable() && this.data.queue.some(job => job.state === 'queued' && (!job.retryAt || job.retryAt <= this.now()))) queueMicrotask(() => this.drain())
    })
  }
  async run() {
    while (!this.stopped) {
      const job = await this.mutate(async () => {
        const candidate = this.data.queue.find(entry => entry.state === 'queued' && (!entry.retryAt || entry.retryAt <= this.now()))
        if (!candidate) return undefined
        candidate.state = 'sending'; candidate.attempts += 1
        await this.save()
        return { ...candidate }
      })
      if (!job) {
        const waiting = this.data.queue.filter(entry => entry.state === 'queued' && entry.retryAt > this.now())
        if (waiting.length) {
          this.timer = setTimeout(() => this.drain(), Math.max(50, Math.min(...waiting.map(entry => entry.retryAt)) - this.now()))
          this.timer.unref?.()
        }
        return
      }
      const device = this.data.devices[job.owner]
      let result = 'unknown', status = 0
      if (!device || job.expires < this.now() || (job.private && !device.includePrivate) || (job.kind !== 'test' && !this.targetAllowed(job.target, device))) result = 'skipped'
      else {
        try {
          validatePushSubscription(device.subscription)
          let deadline
          const expired = new Promise((_, reject) => {
            deadline = setTimeout(() => { this.agent.destroy(); reject(pushError('push/timeout')) }, 8000)
          })
          let response
          try {
            response = await Promise.race([this.send(device.subscription, JSON.stringify({ kind: job.kind, target: job.target, tag: job.id, language: device.language }), {
              vapidDetails: { subject, ...this.keys }, TTL, timeout: 7000, urgency: ['approval', 'answer', 'failure'].includes(job.kind) ? 'high' : 'normal', topic: job.id, agent: this.agent,
            }), expired])
          } finally { clearTimeout(deadline) }
          status = response.statusCode
          result = status >= 200 && status < 300 ? 'accepted' : 'rejected'
        } catch (error) { status = typeof error?.statusCode === 'number' ? error.statusCode : 0; result = status ? 'rejected' : 'unknown' }
      }
      if (this.stopped) return
      await this.mutate(async () => {
        const current = this.data.devices[job.owner]
        if ((status === 404 || status === 410) && current?.fingerprint === device?.fingerprint) delete this.data.devices[job.owner]
        const entry = this.data.queue.find(item => item.id === job.id)
        if ((status === 429 || status === 503) && entry && job.attempts < 3 && job.expires > this.now()) {
          entry.state = 'queued'; entry.retryAt = this.now() + 2000 * job.attempts
        } else this.data.queue = this.data.queue.filter(item => item.id !== job.id)
        if (job.kind === 'test' && current?.fingerprint === device?.fingerprint) current.lastTest = { state: result, at: this.now() }
        await this.save()
      })
    }
  }
  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.agent.destroy()
    await this.serial
    // A sending job stays durable as sending, hence unknown on the next start.
    await this.running
  }
}
