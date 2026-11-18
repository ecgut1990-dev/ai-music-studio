// Where the app's sound goes and how (Settings → Audio, docs/AUDIO-PLAN.md): the output and input device, the
// sample rate and buffer size of live playback, the driver error compensation for recordings, the test tone and the
// simulated CPU load. Every player of the app asks here for its device (setSinkId).

export interface AudioSettings {
  driver: 'windows' | 'asio'
  outputId: string          // '' = the Windows default device
  inputId: string           // '' = the Windows default device, 'none' = no input
  sampleRate: number        // 0 = what the device uses
  buffer: number            // samples; 0 = automatic (small)
  compensationMs: number    // recordings are moved this much earlier (driver error compensation)
}

const KEY = 'ams-audio-device'
const DEFAULTS: AudioSettings = { driver: 'windows', outputId: '', inputId: '', sampleRate: 0, buffer: 0, compensationMs: 0 }

let current: AudioSettings = load()
const listeners = new Set<(s: AudioSettings, rebuild: boolean) => void>()

function load(): AudioSettings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return { ...DEFAULTS } }
}

export function audioSettings(): AudioSettings { return current }

/** saves; `rebuild` is true when live playback has to be started again (sample rate, buffer) */
export function setAudioSettings(patch: Partial<AudioSettings>): void {
  const before = current
  current = { ...current, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* not saved */ }
  const rebuild = before.sampleRate !== current.sampleRate || before.buffer !== current.buffer
  for (const l of listeners) l(current, rebuild)
}

export function onAudioSettings(fn: (s: AudioSettings, rebuild: boolean) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** options for the Studio's AudioContext */
export function contextOptions(): AudioContextOptions {
  const s = current
  const rate = s.sampleRate || undefined
  const o: AudioContextOptions = { latencyHint: s.buffer > 0 ? s.buffer / (rate ?? 48000) : 'interactive' }
  if (rate) o.sampleRate = rate
  return o
}

type Sinkable = { setSinkId?: (id: string) => Promise<void> }

/** sends a player (AudioContext or <audio>) to the chosen output device; false when that device is gone */
export async function applyOutput(target: AudioContext | HTMLMediaElement | null | undefined): Promise<boolean> {
  const t = target as unknown as Sinkable | null
  if (!t || typeof t.setSinkId !== 'function') return true
  try { await t.setSinkId(current.outputId || ''); return true }
  catch {
    try { await t.setSinkId('') } catch { /* stays where it is */ }
    return false
  }
}

export interface Devices { outputs: MediaDeviceInfo[]; inputs: MediaDeviceInfo[] }

export async function listDevices(): Promise<Devices> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    // "default" and "communications" are aliases Windows adds; the list shows the real devices
    const real = (d: MediaDeviceInfo): boolean => d.deviceId !== 'default' && d.deviceId !== 'communications'
    return { outputs: all.filter((d) => d.kind === 'audiooutput' && real(d)), inputs: all.filter((d) => d.kind === 'audioinput' && real(d)) }
  } catch { return { outputs: [], inputs: [] } }
}

/** the microphone of the recording, as chosen in Settings → Audio */
export function inputConstraints(): MediaTrackConstraints {
  const c: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  if (current.inputId && current.inputId !== 'none') c.deviceId = { exact: current.inputId }
  return c
}

/** latency of the input in ms (the audio system's own value), null when it cannot be told */
export async function measureInputLatency(): Promise<number | null> {
  if (current.inputId === 'none') return null
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: inputConstraints() })
    const lat = (s.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number }).latency
    s.getTracks().forEach((t) => t.stop())
    return typeof lat === 'number' ? lat * 1000 : null
  } catch { return null }
}

// ── test tone and simulated CPU load (on the Studio's context, so they go where the music goes) ──────────────
let tone: { osc: OscillatorNode; gain: GainNode } | null = null

export function testTone(ctx: AudioContext, on: boolean, db: number, freq: number): void {
  if (!on) {
    if (tone) { const t = tone; tone = null; t.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.02); setTimeout(() => { try { t.osc.stop() } catch { /* stopped */ } }, 150) }
    return
  }
  const level = Math.pow(10, Math.max(-60, Math.min(0, db)) / 20)
  if (tone) {
    tone.osc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.01)
    tone.gain.gain.setTargetAtTime(level, ctx.currentTime, 0.02)
    return
  }
  const osc = ctx.createOscillator()
  osc.frequency.value = Math.max(20, Math.min(20000, freq))
  const gain = ctx.createGain()
  gain.gain.value = 0
  gain.gain.setTargetAtTime(level, ctx.currentTime, 0.05)            // fades in: no click, no jump in loudness
  osc.connect(gain).connect(ctx.destination)
  osc.start()
  tone = { osc, gain }
}

let load_: AudioWorkletNode | null = null

/** burns `percent` of every audio block, to find a buffer size that does not crackle (0: off) */
export function simulateLoad(ctx: AudioContext, percent: number): void {
  if (percent <= 0) {
    if (load_) { load_.port.postMessage({ percent: 0, stop: true }); load_.disconnect(); load_ = null }
    return
  }
  if (!load_) {
    try {
      load_ = new AudioWorkletNode(ctx, 'ams-cpu', { numberOfInputs: 0, numberOfOutputs: 1 })
      const silent = ctx.createGain(); silent.gain.value = 0
      load_.connect(silent).connect(ctx.destination)
    } catch { load_ = null; return }
  }
  load_.port.postMessage({ percent: Math.min(95, percent) })
}

export function stopTests(ctx: AudioContext | null): void {
  if (!ctx) return
  testTone(ctx, false, 0, 0)
  simulateLoad(ctx, 0)
}
