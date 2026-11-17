// Starts and stops the VST plugin host (ams-plugin-host, see packages/plugin-host and docs/VST-PLAN.md).
// The host runs only while a plugin is in use: the page asks for it with plugins:host, and it is stopped when the
// page says no plugin is left (plugins:release) or the app quits. If it crashes, the page is told (plugins:host-exit)
// and loads its plugins again with their saved state.
import { app, ipcMain, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

const EXE = process.platform === 'win32' ? 'ams-plugin-host.exe' : 'ams-plugin-host'

export function hostPath(): string | null {
  const candidates = [
    process.env.AMS_PLUGIN_HOST ?? '',
    join(process.resourcesPath ?? '', 'plugin-host', EXE),
    join(app.getAppPath(), '..', '..', 'packages', 'plugin-host', 'dist', EXE),   // development checkout
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

let child: ChildProcess | null = null
let info: Promise<{ port: number; token: string }> | null = null

function start(): Promise<{ port: number; token: string }> {
  const exe = hostPath()
  if (!exe) return Promise.reject(new Error('The plugin host is not installed with this version.'))
  const token = randomBytes(24).toString('hex')
  return new Promise((resolve, reject) => {
    const p = spawn(exe, [], { env: { ...process.env, AMS_HOST_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child = p
    let out = ''
    const timer = setTimeout(() => { reject(new Error('The plugin host did not start.')); p.kill() }, 20000)
    p.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
      const m = out.match(/AMS_PLUGIN_HOST_PORT (\d+)/)
      if (m) { clearTimeout(timer); resolve({ port: Number(m[1]), token }) }
    })
    p.stderr?.on('data', (d: Buffer) => console.log('[plugin-host]', d.toString().trim()))
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (child === p) { child = null; info = null }
      console.log(`[plugin-host] exited (${code ?? signal})`)
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('plugins:host-exit', { code, signal })
      reject(new Error('The plugin host stopped.'))
    })
  })
}

export function stopPluginHost(): void {
  const p = child
  child = null; info = null
  if (!p) return
  try { p.stdin?.end() } catch { /* closed */ }                  // the host quits when its input closes
  setTimeout(() => { if (p.exitCode === null) p.kill() }, 3000)
}

// the plugin list of the last search, kept between starts
const listPath = (): string => join(app.getPath('userData'), 'plugins.json')

export function registerPluginHostHandlers(): void {
  ipcMain.handle('plugins:available', () => hostPath() !== null)
  ipcMain.handle('plugins:host', async () => {
    if (!info) { info = start(); info.catch(() => { info = null }) }
    return info
  })
  ipcMain.handle('plugins:release', () => stopPluginHost())
  // native handle of the app window: plugin windows are owned by it (they stay above the app, not above other programs)
  ipcMain.handle('plugins:window-handle', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return ''
    const b = w.getNativeWindowHandle()
    return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0))
  })
  ipcMain.handle('plugins:list-read', () => { try { return JSON.parse(readFileSync(listPath(), 'utf-8')) } catch { return null } })
  ipcMain.handle('plugins:list-write', (_e, data: unknown) => {
    mkdirSync(dirname(listPath()), { recursive: true })
    writeFileSync(listPath(), JSON.stringify(data, null, 1))
  })
  app.on('before-quit', () => stopPluginHost())
}
