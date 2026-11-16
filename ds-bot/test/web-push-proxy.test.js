import assert from 'node:assert/strict'
import { test } from 'node:test'
import { homeDestination } from '../../docs/deploy/tailscale-identity-proxy.example.mjs'

test('PWA identity-proxy return paths are fixed home entries, never arbitrary redirects', () => {
  assert.equal(homeDestination('/'), '/')
  assert.equal(homeDestination('/index.html'), '/')
  assert.equal(homeDestination('/?dsbot-pwa=1'), '/?dsbot-pwa=1')
  assert.equal(homeDestination('/?dsbot-pwa=1&dsbot-pwa-setup=1'), '/?dsbot-pwa=1&dsbot-pwa-setup=1')
  assert.equal(homeDestination('/?dsbot-pwa=1&dsbot-push=bot-fixture'), '/?dsbot-pwa=1&dsbot-push=bot-fixture')
  for (const url of ['//evil.test/?dsbot-pwa=1', '/api/bot?dsbot-pwa=1', '/?dsbot-pwa=1&next=https://evil.test', '/?dsbot-pwa=1&dsbot-push=//evil.test', '/?dsbot-pwa=1&dsbot-pwa=1', '/?dsbot-pwa=1&token=fixture', '/?dsbot-pwa=1#external']) assert.equal(homeDestination(url), null)
})
