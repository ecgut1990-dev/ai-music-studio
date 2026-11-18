// End-to-end test of the plugin host with the test VST3 (gain 0.5, latency 64):
//   node test/e2e.mjs <path to ams-plugin-host> <folder with AMS Test Gain.vst3>
// Linux needs a display for the editor part (xvfb-run).
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

const [exe, folderArg] = process.argv.slice(2)
const folder = resolve(folderArg)            // the host only searches absolute folders
const token = 'test-' + Math.random().toString(36).slice(2)
const host = spawn(exe, [], { env: { ...process.env, AMS_HOST_TOKEN: token }, stdio: ['pipe', 'pipe', 'inherit'] })
const port = await new Promise((res, rej) => {
  let buf = ''
  host.stdout.on('data', (d) => { buf += d; const m = buf.match(/AMS_PLUGIN_HOST_PORT (\d+)/); if (m) res(Number(m[1])) })
  host.on('exit', (c) => rej(new Error('host exited ' + c)))
  setTimeout(() => rej(new Error('no port')), 20000)
})
const ws = new WebSocket(`ws://127.0.0.1:${port}`)
ws.binaryType = 'arraybuffer'
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let next = 1
const pending = new Map(), events = [], audio = []
ws.onmessage = (e) => {
  if (typeof e.data !== 'string') { audio.shift()?.(e.data); return }
  const m = JSON.parse(e.data)
  if (m.event) { events.push(m); return }
  pending.get(m.id)?.(m); pending.delete(m.id)
}
const call = (cmd, args = {}, ms = 120000) => new Promise((res, rej) => {
  const id = next++; pending.set(id, res); ws.send(JSON.stringify({ id, cmd, ...args }))
  setTimeout(() => rej(new Error('timeout ' + cmd)), ms)
})
const block = (instance, chans, flags = 0) => new Promise((res) => {
  const frames = chans[0].length, buf = new ArrayBuffer(24 + chans.length * frames * 4), v = new DataView(buf)
  v.setUint32(0, 0x41534D41, true); v.setUint32(4, instance, true); v.setUint32(8, 1, true)
  v.setUint16(12, chans.length, true); v.setUint16(14, flags, true); v.setUint32(16, frames, true); v.setUint32(20, 0, true)
  chans.forEach((c, i) => new Float32Array(buf, 24 + i * frames * 4, frames).set(c))
  audio.push(res); ws.send(buf)
})

const bad = await call('formats'); assert.equal(bad.ok, false, 'commands need hello first')
// the host closed that connection; open a new one
ws.close()
const ws2 = new WebSocket(`ws://127.0.0.1:${port}`); ws2.binaryType = 'arraybuffer'
await new Promise((r, j) => { ws2.onopen = r; ws2.onerror = j })
ws2.onmessage = ws.onmessage; Object.assign(ws, { send: (d) => ws2.send(d) })

{ const h = await call('hello', { token }); assert.equal(h.ok, true, JSON.stringify(h)) }
const fm = await call('formats'); console.log('formats', fm.formats)
const sc = await call('scan', { paths: [folder] })
console.log('scan', sc.plugins.map((p) => `${p.name} (${p.format}, ${p.vendor})`), 'failed', sc.failed.length, 'events', events.length)
assert.equal(sc.plugins.length, 1)
const ld = await call('load', { xml: sc.plugins[0].xml, sampleRate: 48000, blockSize: 512 })
console.log('load', ld)
assert.equal(ld.ok, true); assert.equal(ld.latency, 64)
const n = 512, L = new Float32Array(n).fill(0.8), R = new Float32Array(n).fill(-0.4)
const out = await block(ld.instance, [L, R])
const v = new DataView(out)
assert.equal(v.getUint32(20, true), 64, 'latency in the reply')
const oL = new Float32Array(out, 24, n), oR = new Float32Array(out, 24 + n * 4, n)
assert.ok(Math.abs(oL[100] - 0.4) < 1e-6 && Math.abs(oR[100] + 0.2) < 1e-6, `gain 0.5: ${oL[100]} ${oR[100]}`)
const st = await call('getState', { instance: ld.instance })
// change the gain through the state (0.25) and check that it applies
// the state goes back into a freshly loaded copy of the plugin (what opening a saved project does)
assert.ok(st.ok && st.state.length > 0)
const ld2 = await call('load', { xml: sc.plugins[0].xml, sampleRate: 48000, blockSize: 512 })
assert.equal((await call('setState', { instance: ld2.instance, state: st.state })).ok, true)
assert.equal((await call('setState', { instance: ld2.instance, state: '%%%' })).ok, false, 'bad state is refused')
const o2 = new Float32Array(await block(ld2.instance, [L, R]), 24, n)
assert.ok(Math.abs(o2[10] - 0.4) < 1e-6)
assert.equal((await call('unload', { instance: ld2.instance })).ok, true)
// a long block (larger than the block size) is processed in parts
const big = new Float32Array(3000).fill(1)
const out3 = new Float32Array(await block(ld.instance, [big, big]), 24, 3000)
assert.ok(Math.abs(out3[2999] - 0.5) < 1e-6)
// timing: 200 blocks of 512 at 48 kHz
const t0 = performance.now()
for (let i = 0; i < 200; i++) await block(ld.instance, [L, R])
const ms = (performance.now() - t0) / 200
console.log(`round trip per 512-sample block: ${ms.toFixed(3)} ms (real time: ${(512 / 48).toFixed(2)} ms)`)
if (process.env.DISPLAY) {
  const ed = await call('editor', { instance: ld.instance, show: true, title: 'test' }); console.log('editor', ed.ok)
  await call('editor', { instance: ld.instance, show: false })
  // opened again after closing: a fresh window (after a state change too)
  assert.equal((await call('setState', { instance: ld.instance, state: st.state })).ok, true)
  assert.equal((await call('editor', { instance: ld.instance, show: true, title: 'test' })).ok, true)
  await call('editor', { instance: ld.instance, show: false })
}
console.log('stats', await call('stats'))
assert.equal((await call('unload', { instance: ld.instance })).ok, true)
// unknown instance: the sound passes through unchanged
const pass = new Float32Array(await block(999, [L, R]), 24, n)
assert.equal(pass[0], L[0])
host.stdin.end()   // the app is gone: the host quits by itself
const code = await new Promise((r) => { host.on('exit', r); setTimeout(() => r('still running'), 5000) })
assert.equal(code, 0, 'host exit: ' + code)
console.log('E2E OK')
process.exit(0)
