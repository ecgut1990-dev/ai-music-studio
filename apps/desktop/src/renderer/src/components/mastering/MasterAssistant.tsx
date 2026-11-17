import React, { useEffect, useRef, useState } from 'react'
import i18n from '../../i18n'
import { tr } from '../../i18n/tr'
import { masterPlayer } from '../../audio/master/player'
import { BANDS, PROFILES, bandLabel, bassWidth, measureBalance, profileLabel, silenceAtEdges, suggest, type Balance, type Suggestion } from '../../audio/master/assistant'
import { analyze, type Analysis } from '../../audio/master/dsp'
import type { Chain } from '../../audio/master/chain'
import type { EditOp } from '../../audio/master/edit'

// The assistant: a big button measures the song, compares its tone balance with a genre (or a reference song) and
// lists proposals with reasons. Tick what you want, Apply; Undo brings the chain from before back.

const later = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

async function decodeRef(path: string): Promise<AudioBuffer> {
  const bytes: Uint8Array = await window.api.fs.readFile(path)
  return new OfflineAudioContext(2, 1, 48000).decodeAudioData(new Uint8Array(bytes).buffer)
}

export function MasterAssistant({ buffer, before, chain, onApply, onEdit, onTarget, onReach, reaching }: {
  buffer: AudioBuffer
  before: Analysis | null
  chain: Chain
  onApply: (c: Chain) => void
  onEdit: (op: EditOp) => void
  onTarget: (target: string) => void
  onReach: (target: string) => void
  reaching: boolean
}): React.ReactElement {
  const lang = (i18n.language || 'en').slice(0, 2)
  const [applied, setApplied] = useState<string[] | null>(null)
  const [genre, setGenre] = useState<string>(() => localStorage.getItem('ams-master-genre') ?? 'techno')
  const [refPath, setRefPath] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [list, setList] = useState<Suggestion[] | null>(null)
  const [bal, setBal] = useState<{ song: Balance; target: Balance } | null>(null)
  const [undo, setUndo] = useState<Chain | null>(null)
  const [error, setError] = useState<string | null>(null)
  const profile = PROFILES.find((p) => p.id === genre) ?? PROFILES[0]

  const run = async (): Promise<void> => {
    setError(null); setBusy('Measuring the song…')
    try {
      await later()
      const ch = [buffer.getChannelData(0), buffer.getChannelData(1)]
      const a = before ?? analyze(ch, buffer.sampleRate)
      const song = measureBalance(ch, buffer.sampleRate)
      let ref: Balance | null = null
      if (refPath) {
        setBusy('Measuring the reference…'); await later()
        const rb = await decodeRef(refPath)
        ref = measureBalance([rb.getChannelData(0), rb.getChannelData(rb.numberOfChannels > 1 ? 1 : 0)], rb.sampleRate)
      }
      const sug = suggest(a, song, bassWidth(ch, buffer.sampleRate), profile, ref, silenceAtEdges(ch, buffer.sampleRate), lang)
      setApplied(null)
      setBal({ song, target: ref ?? profile.balance })
      setList(sug)
    } catch (e) {
      setError(`${tr('The analysis failed:')} ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const apply = (): void => {
    if (!list) return
    setUndo(chain)
    let c = chain
    for (const s of list) if (s.on && s.apply) c = s.apply(c)
    onApply(c)
    for (const s of list) if (s.on && s.edit) onEdit(s.edit)
    if (list.some((s) => s.on && s.reach)) { onTarget(profile.target); setTimeout(() => onReach(profile.target), 50) }
    setApplied(list.filter((s) => s.on && (s.apply || s.edit || s.reach)).map((s) => s.text))
    setList(list.map((s) => ({ ...s, on: false, applied: s.on } as Suggestion & { applied?: boolean })))
    masterPlayer.setBypass(false)                    // hear the result
  }

  // a new style or reference: measure again at once (when there are proposals on screen)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (list) void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genre, refPath])

  const tick = (id: string): void => setList((l) => l && l.map((s) => (s.id === id ? { ...s, on: !s.on } : s)))
  const AREA: Record<Suggestion['area'], string> = { tone: tr('Tone'), dynamics: tr('Dynamics'), stereo: 'Stereo', loudness: tr('Loudness'), edit: tr('File'), note: tr('Note') }

  return (
    <div style={{ background: 'linear-gradient(135deg, rgba(124,58,237,0.22), rgba(124,58,237,0.06))', border: '1px solid var(--accent)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" style={{ fontSize: 14, fontWeight: 700, padding: '10px 18px' }} disabled={!!busy} onClick={() => void run()}>
          ✨ {busy ? tr(busy) : tr('Analyse & suggest')}
        </button>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{tr('Style')}{' '}
          <select value={genre} onChange={(e) => { setGenre(e.target.value); try { localStorage.setItem('ams-master-genre', e.target.value) } catch { /* */ } }} style={{ fontSize: 12 }}>
            {PROFILES.map((p) => <option key={p.id} value={p.id}>{profileLabel(p, lang)}</option>)}
          </select>
        </label>
        <button className="btn btn-ghost" style={{ fontSize: 11 }} title={tr('Compare the tone balance with a song you like instead of the style')}
          onClick={async () => { const p = await window.api.dialog.openAudio(); if (p[0]) setRefPath(p[0]) }}>{tr('Reference song…')}</button>
        {refPath && <span className="truncate" style={{ fontSize: 11, color: 'var(--text-secondary)', maxWidth: 200 }} title={refPath}>
          {refPath.split(/[\\/]/).pop()} <button className="btn btn-ghost" style={{ fontSize: 10, padding: '0 4px' }} onClick={() => setRefPath(null)}>×</button></span>}
        {undo && <button className="btn btn-ghost" style={{ fontSize: 11, marginLeft: 'auto' }} title={tr('Bring back the chain from before the suggestions')}
          onClick={() => { onApply(undo); setUndo(null); setApplied(null) }}>↶ {tr('Undo suggestions')}</button>}
      </div>
      {!list && !busy && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{tr('Measures tone balance, dynamics, stereo and loudness and proposes settings for the chain, each with its reason. Nothing changes until you press Apply.')}</div>}
      {list && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{tr('Compared with:')} <b>{refPath ? `${tr('Reference')} „${refPath.split(/[\\/]/).pop()}“` : profileLabel(profile, lang)}</b></div>}
      {applied && (
        <div style={{ fontSize: 12, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.5)', borderRadius: 6, padding: '6px 10px' }}>
          <b style={{ color: 'var(--green)' }}>✓ {tr('Applied')} ({applied.length})</b>{reaching ? ` · ${tr('setting the loudness target…')}` : ` · ${tr('you hear "After" now; the chain below shows the new settings.')}`}
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--text-secondary)', fontSize: 11 }}>{applied.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      {error && <div style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>}

      {bal && (
        <div title={tr('Tone balance per band: the song (purple) against the target (green line)')}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${BANDS.length}, 1fr)`, gap: 4, alignItems: 'end', height: 70 }}>
            {BANDS.map((b) => {
              const v = bal.song[b.id], t = bal.target[b.id]
              const y = (x: number): number => 35 - Math.max(-12, Math.min(12, x)) * 2.6
              return (
                <div key={b.id} style={{ position: 'relative', height: 70 }}>
                  <div style={{ position: 'absolute', left: '20%', right: '20%', top: Math.min(y(v), 35), height: Math.abs(y(v) - 35), background: Math.abs(v - t) > 2 ? 'var(--accent)' : 'rgba(157,95,248,0.5)', borderRadius: 2 }} />
                  <div style={{ position: 'absolute', left: 0, right: 0, top: y(t), height: 2, background: 'var(--green)' }} />
                  <div style={{ position: 'absolute', left: 0, right: 0, top: 35, height: 1, background: 'rgba(255,255,255,0.15)' }} />
                </div>
              )
            })}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${BANDS.length}, 1fr)`, gap: 4, fontSize: 9, color: 'var(--text-muted)', textAlign: 'center' }}>
            {BANDS.map((b) => <span key={b.id}>{bandLabel(b.id, lang)}<br />{(bal.song[b.id] - bal.target[b.id] > 0 ? '+' : '') + (bal.song[b.id] - bal.target[b.id]).toFixed(1)}</span>)}
          </div>
        </div>
      )}

      {list && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {list.map((s) => {
            const done = (s as Suggestion & { applied?: boolean }).applied
            return (
              <label key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, background: 'var(--bg-tertiary)', borderRadius: 6, padding: '6px 8px', opacity: s.area === 'note' ? 0.85 : 1 }}>
                {s.area !== 'note' ? <input type="checkbox" checked={s.on} disabled={done} onChange={() => tick(s.id)} style={{ marginTop: 2, accentColor: 'var(--accent)' }} /> : <span style={{ width: 13 }}>ⓘ</span>}
                <span style={{ fontSize: 10, color: 'var(--accent-light)', minWidth: 62, textTransform: 'uppercase', marginTop: 1 }}>{AREA[s.area]}</span>
                <span style={{ flex: 1, color: done ? 'var(--green)' : 'var(--text-primary)' }}>{done ? '✓ ' : ''}{s.text}</span>
              </label>
            )
          })}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={!list.some((s) => s.on && (s.apply || s.edit || s.reach))} onClick={apply}>{tr('Apply ticked')}</button>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setList(list.map((s) => ({ ...s, on: s.area !== 'note' && !(s as Suggestion & { applied?: boolean }).applied })))}>{tr('Tick all')}</button>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setList(list.map((s) => ({ ...s, on: false })))}>{tr('None')}</button>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{tr('Compare with Before / After afterwards; every control stays adjustable.')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
