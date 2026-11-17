// Starts and stops the VST plugin host (ams-plugin-host, see packages/plugin-host and docs/VST-PLAN.md).
// The host runs only while a plugin is in use: the page asks for it with plugins:host, and it is stopped when the
// page says no plugin is left (plugins:release) or the app quits. If it crashes, the page is told (plugins:host-exit)
// and loads its plugins again with their saved state.
import { app, ipcMain, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

// two hosts: the 64-bit one for 64-bit plugins and a 32-bit one for 32-bit plugins (ams-plugin-host32.exe)
export type Arch = 'x64' | 'x86'
const exeName = (arch: Arch): string => `ams-plugin-host${arch === 'x86' ? '32' : ''}${process.platform === 'win32' ? '.exe' : ''}`

export function hostPath(arch: Arch = 'x64'): string | null {
  const candidates = [
    arch === 'x64' ? process.env.AMS_PLUGIN_HOST ?? '' : '',
    join(process.resourcesPath ?? '', 'plugin-host', exeName(arch)),
    join(app.getAppPath(), '..', '..', 'packages', 'plugin-host', 'dist', exeName(arch)),   // development checkout
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

const children = new Map<Arch, ChildProcess>()
const infos = new Map<Arch, Promise<{ port: number; token: string }>>()

function start(arch: Arch): Promise<{ port: number; token: string }> {
  const exe = hostPath(arch)
  if (!exe) return Promise.reject(new Error(arch === 'x86' ? 'The 32-bit plugin host is not installed with this version.' : 'The plugin host is not installed with this version.'))
  const token = randomBytes(24).toString('hex')
  return new Promise((resolve, reject) => {
    const p = spawn(exe, [], { env: { ...process.env, AMS_HOST_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.set(arch, p)
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
      if (children.get(arch) === p) { children.delete(arch); infos.delete(arch) }
      console.log(`[plugin-host ${arch}] exited (${code ?? signal})`)
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('plugins:host-exit', { code, signal, arch })
      reject(new Error('The plugin host stopped.'))
    })
  })
}

export function stopPluginHost(arch?: Arch): void {
  for (const a of arch ? [arch] : [...children.keys()]) {
    const p = children.get(a)
    children.delete(a); infos.delete(a)
    if (!p) continue
    try { p.stdin?.end() } catch { /* closed */ }                // the host quits when its input closes
    setTimeout(() => { if (p.exitCode === null) p.kill() }, 3000)
  }
}

// the plugin list of the last search, kept between starts
const listPath = (): string => join(app.getPath('userData'), 'plugins.json')

export function registerPluginHostHandlers(): void {
  ipcMain.handle('plugins:available', () => hostPath() !== null)
  ipcMain.handle('plugins:host', async (_e, arch: Arch = 'x64') => {
    let info = infos.get(arch)
    if (!info) { info = start(arch); infos.set(arch, info); info.catch(() => { if (infos.get(arch) === info) infos.delete(arch) }) }
    return info
  })
  ipcMain.handle('plugins:release', (_e, arch?: Arch) => stopPluginHost(arch))
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
