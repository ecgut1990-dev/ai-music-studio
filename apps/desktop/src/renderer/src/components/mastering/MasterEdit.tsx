import React, { useEffect, useState } from 'react'
import { masterPlayer } from '../../audio/master/player'
import { copyPart, type EditOp, type FadeCurve } from '../../audio/master/edit'
import { useMasteringStore } from '../../stores/mastering.store'
import { useUIStore } from '../../stores/ui.store'
import type { Analysis } from '../../audio/master/dsp'
import { tr, trf } from '../../i18n/tr'

// Editing bar under the waveform. The marked region (drag in the waveform) is what Cut, Copy, Delete, Crop, Silence,
// Fade, Gain and Normalise work on; Paste inserts at the play position. Ctrl+X / C / V, Delete, Ctrl+Z / Y work too.
// The original file is never changed: the steps are listed and can be undone; they are applied on export.

let clipboard: Float32Array[] | null = null

// one step of the list, in the language chosen in Settings
function opLabel(op: EditOp): string {
  const t = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`
  switch (op.type) {
    case 'delete': return trf('Cut {a}–{b}', { a: t(op.start), b: t(op.end) })
    case 'crop': return trf('Crop to {a}–{b}', { a: t(op.start), b: t(op.end) })
    case 'paste': return trf('Paste {s} s at {a}', { s: (op.clip[0].length / 48000).toFixed(2), a: t(op.at) })
    case 'silence': return trf('Silence {a}–{b}', { a: t(op.start), b: t(op.end) })
    case 'insertSilence': return trf('Insert {s} s silence at {a}', { s: op.seconds.toFixed(2), a: t(op.at) })
    case 'fade': return trf(op.dir === 'in' ? 'Fade in {a}–{b}' : 'Fade out {a}–{b}', { a: t(op.start), b: t(op.end) })
    case 'gain': return trf('Gain {db} dB {a}–{b}', { db: `${op.db > 0 ? '+' : ''}${op.db}`, a: t(op.start), b: t(op.end) })
    case 'normalize': return trf('Normalise to {n}', { n: `${op.target} ${op.mode === 'peak' ? 'dBFS' : 'LUFS'}` })
    case 'dc': return tr('Remove DC offset')
    case 'trim': return tr('Trim silence at start and end')
  }
}

const btn: React.CSSProperties = { fontSize: 11, padding: '3px 8px' }
const fmt = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`

export function MasterEdit({ buffer, stats, ops, canRedo, onEdit, onUndo, onRedo, path }: {
  buffer: AudioBuffer
  stats: Analysis | null
  ops: EditOp[]
  canRedo: boolean
  onEdit: (op: EditOp) => void
  onUndo: () => void
  onRedo: () => void
  path: string
}): React.ReactElement {
  const [, tick] = useState(0)
  const [curve, setCurve] = useState<FadeCurve>('smooth')
  const [gain, setGain] = useState(-3)
  const [norm, setNorm] = useState<'peak' | 'lufs'>('peak')
  const [showList, setShowList] = useState(false)
  const markers = useMasteringStore((s) => s.markers[path] ?? [])
  const setMarkers = useMasteringStore((s) => s.setMarkers)
  useEffect(() => masterPlayer.on(() => tick((n) => n + 1)), [])

  const sel = masterPlayer.loop && masterPlayer.loop.end - masterPlayer.loop.start > 0.01 ? masterPlayer.loop : null
  const sr = buffer.sampleRate
  const chans = (): Float32Array[] => [buffer.getChannelData(0), buffer.getChannelData(1)]
  const clearSel = (): void => masterPlayer.setLoop(null, false)

  const cut = (): void => { if (!sel) return; clipboard = copyPart(chans(), sr, sel.start, sel.end); onEdit({ type: 'delete', start: sel.start, end: sel.end }); masterPlayer.seek(sel.start); clearSel() }
  const copy = (): void => { if (sel) { clipboard = copyPart(chans(), sr, sel.start, sel.end); tick((n) => n + 1) } }
  const paste = (): void => { if (clipboard) onEdit({ type: 'paste', at: masterPlayer.position(), clip: clipboard }) }
  const del = (): void => { if (!sel) return; onEdit({ type: 'delete', start: sel.start, end: sel.end }); masterPlayer.seek(sel.start); clearSel() }
  const crop = (): void => { if (!sel) return; onEdit({ type: 'crop', start: sel.start, end: sel.end }); masterPlayer.seek(0); clearSel() }
  const whole = sel ?? { start: 0, end: buffer.duration }

  // keys on this page (the Studio's own shortcuts are left out here, see useShortcuts)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (useUIStore.getState().activeView !== 'mastering') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey
      let done = true
      if (ctrl && k === 'x') cut()
      else if (ctrl && k === 'c') copy()
      else if (ctrl && k === 'v') paste()
      else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) onRedo()
      else if (ctrl && k === 'z') onUndo()
      else if (!ctrl && (k === 'delete' || k === 'backspace')) del()
      else done = false
      if (done) { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div style={{ background: 'var(--bg-tertiary)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, marginRight: 4 }}>{tr('Edit')}</span>
        <span style={{ fontSize: 11, color: sel ? 'var(--accent-light)' : 'var(--text-muted)', minWidth: 150 }}>
          {sel ? `${tr('Region')} ${fmt(sel.start)}–${fmt(sel.end)} (${(sel.end - sel.start).toFixed(2)} s)` : tr('Drag in the waveform to mark a region')}
        </span>
        <button className="btn btn-ghost" style={btn} disabled={!sel} title={tr('Cut (Ctrl+X): remove the region and keep it for Paste')} onClick={cut}>✂ {tr('Cut')}</button>
        <button className="btn btn-ghost" style={btn} disabled={!sel} title={tr('Copy (Ctrl+C)')} onClick={copy}>{tr('Copy')}</button>
        <button className="btn btn-ghost" style={btn} disabled={!clipboard} title={tr('Paste at the play position (Ctrl+V)')} onClick={paste}>{tr('Paste')}</button>
        <button className="btn btn-ghost" style={btn} disabled={!sel} title={tr('Delete the region (Del)')} onClick={del}>{tr('Delete')}</button>
        <button className="btn btn-ghost" style={btn} disabled={!sel} title={tr('Keep only the region')} onClick={crop}>{tr('Crop')}</button>
        <button className="btn btn-ghost" style={btn} disabled={!sel} title={tr('Make the region silent')} onClick={() => sel && onEdit({ type: 'silence', start: sel.start, end: sel.end })}>{tr('Silence')}</button>
        <span style={{ width: 1, height: 18, background: 'var(--border-mid)' }} />
        <button className="btn btn-ghost" style={btn} disabled={!sel} title={tr('Fade in over the region')} onClick={() => sel && onEdit({ type: 'fade', start: sel.start, end: sel.end, dir: 'in', curve })}>{tr('Fade in')}</button>
        <button className="btn btn-ghost" style={btn} disabled={!sel} title={tr('Fade out over the region')} onClick={() => sel && onEdit({ type: 'fade', start: sel.start, end: sel.end, dir: 'out', curve })}>{tr('Fade out')}</button>
        <select value={curve} onChange={(e) => setCurve(e.target.value as FadeCurve)} style={{ fontSize: 11 }} title={tr('Fade curve')}>
          <option value="smooth">{tr('S-curve')}</option><option value="linear">{tr('Linear')}</option><option value="log">{tr('Logarithmic')}</option>
        </select>
        <span style={{ width: 1, height: 18, background: 'var(--border-mid)' }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-mid)', borderRadius: 6, padding: '1px 4px 1px 8px' }}
          title={sel ? tr('Change the level of the marked region') : tr('Change the level of the whole song')}>
          <span style={{ fontSize: 11 }}>{tr('Volume')}{sel ? ` (${tr('region')})` : ''}</span>
          <input type="number" value={gain} step={0.5} min={-24} max={24} onChange={(e) => setGain(Number(e.target.value))} style={{ width: 52, fontSize: 11 }} />
          <span style={{ fontSize: 11 }}>dB</span>
          <button className="btn btn-ghost" style={btn} onClick={() => onEdit({ type: 'gain', start: whole.start, end: whole.end, db: gain })}>{tr('Apply')}</button>
        </span>
        <select value={norm} onChange={(e) => setNorm(e.target.value as 'peak' | 'lufs')} style={{ fontSize: 11 }}>
          <option value="peak">{tr('Peak')} {tr('−1 dBFS')}</option><option value="lufs">{tr('Loudness')} {tr('−14 LUFS')}</option>
        </select>
        <button className="btn btn-ghost" style={btn} title={sel ? tr('Normalise the region') : tr('Normalise the whole song')}
          onClick={() => onEdit({ type: 'normalize', start: whole.start, end: whole.end, mode: norm, target: norm === 'peak' ? -1 : -14 })}>{tr('Normalise')}</button>
        <button className="btn btn-ghost" style={btn} title={tr('Remove silence at the start and the end')} onClick={() => { onEdit({ type: 'trim', thresholdDb: -60 }); masterPlayer.seek(0) }}>{tr('Trim silence')}</button>
        <button className="btn btn-ghost" style={btn} title={tr('Remove a DC offset (the waveform shifted up or down)')} onClick={() => onEdit({ type: 'dc' })}>{tr('DC')}</button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost" style={btn} title={tr('Marker at the play position')} onClick={() => setMarkers(path, [...markers, { t: masterPlayer.position(), name: trf('Marker {n}', { n: markers.length + 1 }) }].sort((a, b) => a.t - b.t))}>{tr('+ Marker')}</button>
        <button className="btn btn-ghost" style={btn} disabled={!ops.length} title={tr('Undo (Ctrl+Z)')} onClick={onUndo}>↶</button>
        <button className="btn btn-ghost" style={btn} disabled={!canRedo} title={tr('Redo (Ctrl+Y)')} onClick={onRedo}>↷</button>
        <button className="btn btn-ghost" style={btn} disabled={!ops.length} onClick={() => setShowList((v) => !v)}>{ops.length} {tr(ops.length === 1 ? 'step' : 'steps')} {showList ? '▾' : '▸'}</button>
      </div>
      {markers.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {markers.map((m, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, background: 'rgba(234,179,8,0.15)', border: '1px solid rgba(234,179,8,0.5)', borderRadius: 5, padding: '1px 2px 1px 6px' }}>
              <span style={{ cursor: 'pointer' }} title={tr('Jump there')} onClick={() => masterPlayer.seek(m.t)}>{fmt(m.t)}</span>
              <input value={m.name} onChange={(e) => setMarkers(path, markers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} style={{ fontSize: 10, width: 80, background: 'transparent', border: 'none', color: 'var(--text-primary)' }} />
              <button className="btn btn-ghost" style={{ fontSize: 9, padding: '0 3px' }} onClick={() => setMarkers(path, markers.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      {showList && ops.length > 0 && (
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: 'var(--text-secondary)' }}>
          {ops.map((o, i) => <li key={i}>{opLabel(o)}</li>)}
        </ol>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}
        title={tr('The values of the edited song before the chain; the table "Whole song" on the right shows them next to the master.')}>
        {tr('Song now')}: <b>{fmt(buffer.duration)}</b>
        {stats ? <> · <b>{Number.isFinite(stats.integrated) ? stats.integrated.toFixed(1) : '–'}</b> {tr('LUFS ·')} {tr('peak')} <b>{Number.isFinite(stats.samplePeak) ? stats.samplePeak.toFixed(1) : '–'}</b> {tr('dBFS · RMS')} {Number.isFinite(stats.rms) ? stats.rms.toFixed(1) : '–'} dB</> : ` · ${tr('measuring…')}`}
        {ops.length > 0 && <span style={{ color: 'var(--text-muted)' }}> · {tr('Last step')}: {opLabel(ops[ops.length - 1])} · {tr('the original file is not changed; the steps are applied when you export.')}</span>}
      </div>
    </div>
  )
}
