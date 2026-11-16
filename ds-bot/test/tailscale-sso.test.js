import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createSsoProxy, parseLoginUrl, homeDestination } from '../../docs/deploy/tailscale-identity-proxy.example.mjs'

async function fixture(t) {
  const calls = []
  const sockets = new Set()
  const backend = http.createServer((request, response) => {
    calls.push({ path: request.url, loginHeader: request.headers['tailscale-user-login'] })
    const url = new URL(request.url, 'http://fixture')
    if (url.searchParams.has('token')) {
      response.writeHead(303, { location: './', 'set-cookie': 'dsh_session=fixture; HttpOnly; SameSite=Strict; Path=/' })
      response.end()
    } else if (request.headers.cookie === 'dsh_session=fixture') {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => { response.writeHead(200); response.end(Buffer.concat(chunks).length ? Buffer.concat(chunks) : 'DSH UI') })
    } else { response.writeHead(401); response.end('login required') }
  })
  backend.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n')
    socket.on('data', bytes => socket.write(bytes))
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const server = createSsoProxy({ publicOrigin:'https://gateway.test',allowedLogin:'owner@example.test',
    upstreamHost:'127.0.0.1',upstreamPort:backend.address().port,port:3081 },
  { loadLogin:async()=>new URL('https://gateway.test/?token=fixture-login') })
  server.listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve))
  for(const target of [backend,server]) target.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))})
  t.after(()=>{for(const socket of sockets)socket.destroy();server.closeAllConnections();backend.closeAllConnections();server.close();backend.close()})
  const request=(path='/',{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path,method,headers:{host:'gateway.test','tailscale-user-login':'owner@example.test',...headers}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.once('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString()}))
    });req.once('error',reject);req.end(body)
  })
  return {request,calls,port:server.address().port}
}

test('only exact Tailscale identity, authority and same-origin access pass',async t=>{
  const f=await fixture(t)
  for(const headers of [{'tailscale-user-login':'other@example.test'}, {'tailscale-user-login':''},{host:'other.test'},{origin:'https://other.test'},{'sec-fetch-site':'cross-site'}])
    assert.equal((await f.request('/',{headers})).status,403)
  assert.deepEqual(f.calls,[])
})

test('first page exchanges launch token into a Secure HttpOnly cookie and drops the token',async t=>{
  const f=await fixture(t),login=await f.request()
  assert.equal(login.status,200);assert.equal(login.headers.location,undefined)
  assert.match(login.body,/location\.replace\("\/\?dsbot-sso=1"\)/)
  assert.match(login.headers['content-security-policy'],/script-src 'nonce-/)
  assert.match(login.headers['set-cookie'][0],/HttpOnly/);assert.match(login.headers['set-cookie'][0],/SameSite=Strict/);assert.match(login.headers['set-cookie'][0],/; Secure$/)
  assert.equal(JSON.stringify(login).includes('fixture-login'),false)
  assert.equal(f.calls.length,2)
  assert.equal(f.calls[1].path,'/?token=fixture-login')
  assert.ok(f.calls.every(call=>call.loginHeader===undefined))
  const page=await f.request('/',{headers:{cookie:'dsh_session=fixture'}})
  assert.equal(page.status,200);assert.equal(page.body,'DSH UI')
})

test('API requests keep DSH authentication and successful logins never disclose identity headers',async t=>{
  const f=await fixture(t)
  assert.equal((await f.request('/api/bot')).status,401)
  const response=await f.request('/api/bot',{method:'POST',headers:{cookie:'dsh_session=fixture','tailscale-user-name':'spoof'},body:'owner RPC'})
  assert.equal(response.status,200);assert.equal(response.body,'owner RPC')
  assert.deepEqual(f.calls.at(-1),{path:'/api/bot',loginHeader:undefined})
})

test('WebSocket upgrades require the allowed identity and preserve upgrade data',async t=>{
  const f=await fixture(t)
  const accepted=await new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:f.port,path:'/connect',headers:{host:'gateway.test','tailscale-user-login':'owner@example.test',connection:'Upgrade',upgrade:'fixture'}})
    req.once('upgrade',(response,socket)=>{socket.once('data',bytes=>{socket.destroy();resolve({status:response.statusCode,body:bytes.toString()})});socket.write('stream')});req.once('error',reject);req.end()
  })
  assert.deepEqual(accepted,{status:101,body:'stream'})
  const rejected=await new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:f.port,path:'/connect',headers:{host:'gateway.test','tailscale-user-login':'other@example.test',connection:'Upgrade',upgrade:'fixture'}})
    req.once('response',resolve);req.once('upgrade',()=>reject(Error('Unauthorized WebSocket upgraded')));req.once('error',reject);req.end()
  })
  assert.equal(rejected.statusCode,403)
})

test('verified users may follow external links only to an exact top-level home page',async t=>{
  const f=await fixture(t)
  const headers={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}
  assert.equal((await f.request('/',{headers})).status,200)
  assert.equal((await f.request('/index.html',{headers})).status,200)
  for(const path of ['/api/bot','/connect','/?token=untrusted','/?x=1','/asset.js'])
    assert.equal((await f.request(path,{headers})).status,403)
  assert.equal((await f.request('/',{method:'POST',headers})).status,403)
  assert.equal((await f.request('/',{headers:{...headers,'tailscale-user-login':'other@example.test'}})).status,403)
  assert.equal((await f.request('/',{headers:{...headers,origin:'https://other.test'}})).status,403)
  assert.equal((await f.request('/',{headers:{...headers,'sec-fetch-mode':'cors'}})).status,403)
  assert.equal((await f.request('/',{headers:{...headers,'sec-fetch-dest':'iframe'}})).status,403)
})

test('PWA and notification entries retain identity gates and their fixed same-origin return path', async t => {
  const f = await fixture(t)
  const headers = { 'sec-fetch-site':'cross-site', 'sec-fetch-mode':'navigate', 'sec-fetch-dest':'document' }
  for (const path of ['/?dsbot-pwa=1', '/?dsbot-pwa=1&dsbot-pwa-setup=1', '/?dsbot-pwa=1&dsbot-push=bot-fixture']) {
    const response = await f.request(path, { headers })
    assert.equal(response.status, 200)
    assert.equal(response.headers.location, undefined)
    const next = path + '&dsbot-sso=1'
    assert.ok(response.body.includes(JSON.stringify(next)))
    assert.equal((await f.request(next, { headers })).status, 409)
    assert.equal((await f.request(path, { headers: { ...headers, 'tailscale-user-login':'other@example.test' } })).status, 403)
  }
  for (const path of ['/?dsbot-pwa=1&redirect=https://evil.test', '/?dsbot-pwa=1&dsbot-push=https://evil.test', '/?dsbot-pwa=1&dsbot-pwa=1', '/?dsbot-pwa=1&dsbot-pwa-setup=bad', '/api/bot?dsbot-pwa=1']) {
    assert.equal((await f.request(path, { headers })).status, 403)
    assert.equal(homeDestination(path), null)
  }
  assert.equal(homeDestination('//evil.test/?dsbot-pwa=1'), null)
})

test('cookie suppression ends after one committed document without another login exchange', async t => {
  const f = await fixture(t)
  const first = await f.request('/')
  assert.equal(first.status, 200)
  assert.equal(first.headers.location, undefined)
  const stopped = await f.request('/?dsbot-sso=1')
  assert.equal(stopped.status, 409)
  assert.equal(stopped.headers.location, undefined)
  assert.equal(stopped.headers['set-cookie'], undefined)
  assert.match(stopped.body, /自动恢复已停止/)
  assert.equal(stopped.body.includes('<script'), false)
  assert.equal(f.calls.filter(call => call.path.includes('token=')).length, 1)
  assert.equal((await f.request('/?dsbot-sso=1')).status, 409)
  assert.equal(f.calls.filter(call => call.path.includes('token=')).length, 1)
})

test('expired cookies recover after document commit and the resume marker is never authorization', async t => {
  const f = await fixture(t)
  for (const site of ['same-origin', 'cross-site']) {
    const headers = { cookie: 'old=expired', 'sec-fetch-site': site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
    const first = await f.request('/', { headers })
    assert.equal(first.status, 200)
    const cookie = first.headers['set-cookie'].map(value => value.split(';')[0]).join('; ')
    const opened = await f.request('/?dsbot-sso=1', { headers: { ...headers, cookie, 'sec-fetch-site': 'same-origin' } })
    assert.equal(opened.status, 200)
    assert.equal(opened.body, 'DSH UI')
    assert.equal(opened.headers['set-cookie'], undefined)
    assert.equal((await f.request('/?dsbot-sso=1', { headers: { ...headers, cookie, 'tailscale-user-login': 'other@example.test' } })).status, 403)
  }
})

test('ambiguous stale cookies cannot cause an automatic recovery loop or weaken backend auth', async t => {
  const f = await fixture(t)
  const first = await f.request('/')
  const cookie = first.headers['set-cookie'][0].split(';')[0]
  const name = cookie.split('=')[0]
  const duplicate = name + '=stale; ' + cookie
  assert.equal((await f.request('/', { headers: { cookie: duplicate } })).status, 200)
  const stopped = await f.request('/?dsbot-sso=1', { headers: { cookie: duplicate } })
  assert.equal(stopped.status, 409)
  assert.equal((await f.request('/api/bot', { headers: { cookie: duplicate } })).status, 401)
})

test('resume URLs retain only validated PWA targets and reject forged recovery parameters', async t => {
  const f = await fixture(t)
  const path = '/?dsbot-pwa=1&dsbot-pwa-setup=1&dsbot-push=bot-fixture'
  const first = await f.request(path)
  const cookie = first.headers['set-cookie'][0].split(';')[0]
  assert.ok(first.body.includes(JSON.stringify(path + '&dsbot-sso=1')))
  assert.equal(homeDestination(path + '&dsbot-sso=1'), path)
  assert.equal((await f.request(path + '&dsbot-sso=1', { headers: { cookie } })).body, 'DSH UI')
  for (const path of ['/?dsbot-sso=2', '/?dsbot-sso=1&dsbot-sso=1', '/?dsbot-sso=1&next=https://evil.test', '/?dsbot-sso=1&dsbot-push=bad']) {
    assert.equal(homeDestination(path), null)
    assert.equal((await f.request(path)).status, 400)
  }
  assert.equal((await f.request('/api/bot?dsbot-sso=1')).status, 401)
})

test('login transition has no executable input, tokens, caches, or relaxed cookie attributes', async t => {
  const f = await fixture(t)
  const first = await f.request('/?dsbot-pwa=1&dsbot-push=target')
  assert.equal(first.headers['cache-control'], 'no-store')
  assert.equal(first.headers['referrer-policy'], 'no-referrer')
  assert.equal(first.body.includes('fixture-login'), false)
  assert.match(first.headers['set-cookie'][0], /SameSite=Strict/)
  assert.match(first.headers['set-cookie'][0], /HttpOnly/)
  assert.match(first.headers['set-cookie'][0], /Path=\//)
  assert.match(first.headers['set-cookie'][0], /Secure/)
  assert.equal(first.headers['set-cookie'][0].includes('Domain='), false)
  const nonce = first.body.match(/<script nonce="([^"]+)"/)[1]
  assert.ok(first.headers['content-security-policy'].includes("'nonce-" + nonce + "'"))
  assert.match(first.headers['content-security-policy'], /frame-ancestors 'none'/)
})

test('launch token parser accepts the current authority and rejects stale or misplaced tokens',()=>{
  assert.equal(parseLoginUrl('dsh web: https://gateway.test/?token=ok\n','https://gateway.test').searchParams.get('token'),'ok')
  assert.throws(()=>parseLoginUrl('dsh web: https://other.test/?token=bad','https://gateway.test'))
  assert.throws(()=>parseLoginUrl('dsh web: https://gateway.test/path?token=bad','https://gateway.test'))
  assert.throws(()=>parseLoginUrl('','https://gateway.test'))
})
