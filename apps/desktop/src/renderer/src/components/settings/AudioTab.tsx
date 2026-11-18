import React, { useEffect, useState } from 'react'
import { audioSettings, listDevices, measureInputLatency, onAudioSettings, setAudioSettings, simulateLoad, testTone, type Devices } from '../../audio/output'
import { liveContext } from '../../audio/engine'
import { exportSampleRate, setExportSampleRate } from '../../lib/sampleRate'
import { tr, trf } from '../../i18n/tr'

// Settings → Audio, laid out like the audio preferences of other DAWs: Audio device, Sample rate, Latency, Test.
// See docs/AUDIO-PLAN.md. ASIO comes with 0.61 (through the plugin host).

const BUFFERS = [64, 128, 256, 512, 1024, 2048, 4096]
const RATES = [44100, 48000, 88200, 96000]

const section: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', borderBottom: '1px solid var(--border)', paddingBottom: 4, marginTop: 6 }
const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: '220px 1fr', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-secondary)' }
const field: React.CSSProperties = { fontSize: 12, maxWidth: 320 }
const hint: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }

export function AudioTab(): React.ReactElement {
  const [s, setS] = useState(audioSettings())
  const [devices, setDevices] = useState<Devices>({ outputs: [], inputs: [] })
  const [lat, setLat] = useState<{ out: number | null; inp: number | null; rate: number }>({ out: null, inp: null, rate: 0 })
  const [toneOn, setToneOn] = useState(false)
  const [toneDb, setToneDb] = useState(-36)
  const [toneHz, setToneHz] = useState(440)
  const [cpu, setCpu] = useState(0)
  const [missing, setMissing] = useState(false)

  const refresh = async (): Promise<void> => {
    const d = await listDevices()
    setDevices(d)
    setMissing(!!s.outputId && !d.outputs.some((x) => x.deviceId === s.outputId))
  }
  const measure = async (): Promise<void> => {
    const c = liveContext()
    if (c.state === 'suspended') await c.resume().catch(() => {})
    await new Promise((r) => setTimeout(r, 150))
    const out = ((c.baseLatency ?? 0) + ((c as AudioContext & { outputLatency?: number }).outputLatency ?? 0)) * 1000
    setLat({ out, inp: await measureInputLatency(), rate: c.sampleRate })
  }

  useEffect(() => {
    void refresh(); void measure()
    const offDev = (): void => { void refresh() }
    navigator.mediaDevices?.addEventListener?.('devicechange', offDev)
    const off = onAudioSettings((n) => { setS(n); window.setTimeout(() => { void measure() }, 300) })
    return () => {
      off(); navigator.mediaDevices?.removeEventListener?.('devicechange', offDev)
      // leaving the page stops the test tone and the load
      try { const c = liveContext(); testTone(c, false, 0, 0); simulateLoad(c, 0) } catch { /* no context */ }
    }
  }, [])

  const tone = (on: boolean, db = toneDb, hz = toneHz): void => {
    const c = liveContext()
    if (c.state === 'suspended') void c.resume()
    testTone(c, on, db, hz)
  }
  // a new device or buffer: tone and load follow the new context
  useEffect(() => {
    if (toneOn) tone(true)
    if (cpu > 0) simulateLoad(liveContext(), cpu)
  }, [s.outputId, s.sampleRate, s.buffer])

  const name = (d: MediaDeviceInfo, i: number): string => d.label || `${tr('Device')} ${i + 1}`
  const total = (lat.out ?? 0) + (lat.inp ?? 0) + s.compensationMs

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
      <div style={section}>{tr('Audio device')}</div>
      <label style={row}>{tr('Driver type')}
        <select style={field} value={s.driver} onChange={(e) => setAudioSettings({ driver: e.target.value as 'windows' | 'asio' })}>
          <option value="windows">{tr('Windows (standard)')}</option>
          <option value="asio" disabled>{tr('ASIO (coming with 0.61)')}</option>
        </select>
      </label>
      <label style={row}>{tr('Audio input device')}
        <select style={field} value={s.inputId} onChange={(e) => setAudioSettings({ inputId: e.target.value })}>
          <option value="">{tr('Windows default')}</option>
          <option value="none">{tr('No input')}</option>
          {devices.inputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{name(d, i)}</option>)}
        </select>
      </label>
      <label style={row}>{tr('Audio output device')}
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select style={{ ...field, flex: 1 }} value={missing ? '' : s.outputId} onChange={(e) => setAudioSettings({ outputId: e.target.value })}>
            <option value="">{tr('Windows default')}</option>
            {devices.outputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{name(d, i)}</option>)}
          </select>
          <button className="btn btn-ghost" style={{ fontSize: 11 }} title={tr('Search the devices again (after plugging something in)')} onClick={() => void refresh()}>{tr('Refresh')}</button>
        </span>
      </label>
      {missing && <div style={{ ...hint, color: 'var(--orange)' }}>{tr('The chosen output device is not connected: the app plays through the Windows default device.')}</div>}
      <div style={hint}>{tr('The output device is used everywhere in the app: Studio, Mastering, Stem Splitter, Library and the players of Create music.')}</div>

      <div style={section}>{tr('Sample rate')}</div>
      <label style={row}>{tr('Input / output sample rate')}
        <select style={field} value={s.sampleRate} onChange={(e) => setAudioSettings({ sampleRate: Number(e.target.value) })}>
          <option value={0}>{trf('Automatic (device: {rate} Hz)', { rate: lat.rate ? lat.rate.toLocaleString() : '…' })}</option>
          {RATES.map((r) => <option key={r} value={r}>{r.toLocaleString()} Hz</option>)}
        </select>
      </label>
      <label style={row}>{tr('Export sample rate')}
        <select style={field} defaultValue={String(exportSampleRate())} onChange={(e) => setExportSampleRate(Number(e.target.value))}>
          <option value="44100">{tr('44,100 Hz (streaming platforms, CD: recommended)')}</option>
          <option value="48000">{tr('48,000 Hz (video)')}</option>
          <option value="88200">{tr('88,200 Hz')}</option>
          <option value="96000">{tr('96,000 Hz')}</option>
        </select>
      </label>
      <div style={hint}>{tr('Every export uses this rate (File → Export audio, Export… in the Library and the Stem Splitter). AI models often make 48 kHz; the files are converted.')}</div>

      <div style={section}>{tr('Latency')}</div>
      <label style={row}>{tr('Buffer size')}
        <select style={field} value={s.buffer} onChange={(e) => setAudioSettings({ buffer: Number(e.target.value) })}>
          <option value={0}>{tr('Automatic (small)')}</option>
          {BUFFERS.map((b) => <option key={b} value={b}>{b} {tr('samples')}</option>)}
        </select>
      </label>
      <div style={row}>{tr('Input latency')}<span>{lat.inp === null ? '–' : `${lat.inp.toFixed(1)} ms`}</span></div>
      <div style={row}>{tr('Output latency')}<span>{lat.out === null ? '…' : `${lat.out.toFixed(1)} ms`}</span></div>
      <label style={row}>{tr('Driver error compensation')}
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="number" step={0.5} value={s.compensationMs} style={{ width: 80, fontSize: 12 }}
            onChange={(e) => setAudioSettings({ compensationMs: Number(e.target.value) || 0 })} /> ms
        </span>
      </label>
      <div style={row}>{tr('Overall latency')}<b style={{ color: 'var(--text-primary)' }}>{total.toFixed(1)} ms</b></div>
      <div style={hint}>{tr('A smaller buffer reacts faster (playing a keyboard, recording), a larger one is safer against crackling. If recordings land too late or too early, correct it with the driver error compensation (positive: earlier).')}</div>

      <div style={section}>{tr('Test')}</div>
      <div style={row}>{tr('Test tone')}
        <span>
          <button className={`btn ${toneOn ? 'btn-primary' : 'btn-ghost'}`} style={{ fontSize: 12, minWidth: 80 }} onClick={() => { tone(!toneOn); setToneOn(!toneOn) }}>
            {toneOn ? tr('On') : tr('Off')}
          </button>
        </span>
      </div>
      <label style={row}>{tr('Test tone volume')}
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="range" min={-60} max={0} step={1} value={toneDb} style={{ width: 200 }}
            onChange={(e) => { const v = Number(e.target.value); setToneDb(v); if (toneOn) tone(true, v) }} /> {toneDb} dB
        </span>
      </label>
      <label style={row}>{tr('Test tone frequency')}
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="number" min={20} max={20000} step={1} value={toneHz} style={{ width: 90, fontSize: 12 }}
            onChange={(e) => { const v = Number(e.target.value) || 440; setToneHz(v); if (toneOn) tone(true, toneDb, v) }} /> Hz
        </span>
      </label>
      <label style={row}>{tr('Simulated CPU load')}
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="range" min={0} max={90} step={5} value={cpu} style={{ width: 200 }}
            onChange={(e) => { const v = Number(e.target.value); setCpu(v); simulateLoad(liveContext(), v) }} /> {cpu} %
        </span>
      </label>
      <div style={hint}>{tr('The test tone plays on the chosen output device: if you hear it, the right card is set. Turn the simulated load up while a song plays: if it crackles early, choose a larger buffer.')}</div>
    </div>
  )
}
