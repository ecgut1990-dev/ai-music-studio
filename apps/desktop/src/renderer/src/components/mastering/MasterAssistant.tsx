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

export function MasterAssistant({ buffer, after, before, chain, onApply, onEdit, onTarget, onReach, reaching }: {
  buffer: AudioBuffer
  after: AudioBuffer | null        // the song through the chain (measured again after every change)
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
  const [balAfter, setBalAfter] = useState<Balance | null>(null)
  const [round, setRound] = useState<'original' | 'master'>('original')
  const onMaster = !!applied && !!after
  // once something is applied, the bars show the master: its balance is measured each time "after" is new
  useEffect(() => {
    if (!applied || !after) { if (!applied) setBalAfter(null); return }
    const t = setTimeout(() => setBalAfter(measureBalance([after.getChannelData(0), after.getChannelData(1)], after.sampleRate)), 50)
    return () => clearTimeout(t)
  }, [after, applied])
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
      // a second round measures the master (the song through the chain as it is set now)
      const src = onMaster && after ? after : buffer
      const ch = [src.getChannelData(0), src.getChannelData(1)]
      const a = src === buffer && before ? before : analyze(ch, src.sampleRate)
      const song = measureBalance(ch, buffer.sampleRate)
      let ref: Balance | null = null
      if (refPath) {
        setBusy('Measuring the reference…'); await later()
        const rb = await decodeRef(refPath)
        ref = measureBalance([rb.getChannelData(0), rb.getChannelData(rb.numberOfChannels > 1 ? 1 : 0)], rb.sampleRate)
      }
      let sug = suggest(a, song, bassWidth(ch, src.sampleRate), profile, ref, silenceAtEdges(ch, src.sampleRate), lang)
      if (src !== buffer) sug = sug.filter((x) => x.area !== 'edit' && x.area !== 'note' && x.id !== 'squashed')   // the master is limited: only tone and stereo
      setRound(src !== buffer ? 'master' : 'original')
      setApplied(null); setBalAfter(null)
      setBal({ song, target: ref ?? profile.balance })
      setList(sug)
    } catch (e) {
      setError(`${tr('The analysis failed:')} ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  // apply the given proposals (one with its own button, or all ticked ones); Undo goes back to before the first
  const applyIds = (ids: string[]): void => {
    if (!list || !ids.length) return
    const pick = list.filter((s) => ids.includes(s.id) && (s.apply || s.edit || s.reach))
    if (!pick.length) return
    if (!undo) setUndo(chain)
    let c = chain
    for (const s of pick) if (s.apply) c = s.apply(c)
    onApply(c)
    for (const s of pick) if (s.edit) onEdit(s.edit)
    if (pick.some((s) => s.reach)) { onTarget(profile.target); setTimeout(() => onReach(profile.target), 50) }
    setApplied((a) => [...(a ?? []), ...pick.map((s) => s.text)])
    setList(list.map((s) => (ids.includes(s.id) ? { ...s, on: false, applied: true } : s) as Suggestion & { applied?: boolean }))
    masterPlayer.setBypass(false)                    // hear the result
  }
  const apply = (): void => { if (list) applyIds(list.filter((s) => s.on).map((s) => s.id)) }
  const ticked = list ? list.filter((s) => s.on && (s.apply || s.edit || s.reach) && !(s as Suggestion & { applied?: boolean }).applied).length : 0

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
    <div style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent) 22%, transparent), color-mix(in srgb, var(--accent) 6%, transparent))', border: '1px solid var(--accent)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" style={{ fontSize: 14, fontWeight: 700, padding: '10px 18px' }} disabled={!!busy} onClick={() => void run()}>
          ✨ {busy ? tr(busy) : onMaster ? tr('Analyse the master again') : tr('Analyse & suggest')}
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
        <span style={{ flex: 1 }} />
        {list && <button className="btn btn-primary" style={{ fontSize: 13, fontWeight: 700, padding: '8px 14px', background: ticked ? 'var(--green)' : undefined }} disabled={!ticked} onClick={apply}>
          ✓ {tr('Apply all ticked')} ({ticked})</button>}
        <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={!undo} title={tr('Bring back the chain from before the suggestions')}
          onClick={() => { if (undo) { onApply(undo); setUndo(null); setApplied(null); setList((l) => l && l.map((s) => ({ ...s, applied: false } as Suggestion))) } }}>↶ {tr('Undo suggestions')}</button>
      </div>
      {!list && !busy && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{tr('Measures tone balance, dynamics, stereo and loudness and proposes settings for the chain, each with its reason. Nothing changes until you press Apply.')}</div>}
      {list && round === 'master' && <div style={{ fontSize: 11, color: 'var(--accent-light)' }}>{tr('Round 2: measured on the master; the EQ proposals add to what is set.')}</div>}
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
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>
            {balAfter ? <>{tr('Bars')}: <span style={{ color: 'var(--accent-light)' }}>{tr('master (after the chain)')}</span> · <span style={{ color: '#9ca3af' }}>{tr('grey outline: original')}</span> · <span style={{ color: 'var(--green)' }}>{tr('green: target')}</span></>
              : applied ? tr('Measuring the master…') : <>{tr('Bars')}: <span style={{ color: 'var(--accent-light)' }}>{tr('original')}</span> · <span style={{ color: 'var(--green)' }}>{tr('green: target')}</span></>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${BANDS.length}, 1fr)`, gap: 4, alignItems: 'end', height: 70 }}>
            {BANDS.map((b) => {
              const o = bal.song[b.id], v = balAfter ? balAfter[b.id] : o, t = bal.target[b.id]
              const y = (x: number): number => 35 - Math.max(-12, Math.min(12, x)) * 2.6
              return (
                <div key={b.id} style={{ position: 'relative', height: 70 }}>
                  <div style={{ position: 'absolute', left: '20%', right: '20%', top: Math.min(y(v), 35), height: Math.abs(y(v) - 35), background: Math.abs(v - t) > 2 ? 'var(--accent)' : 'rgba(157,95,248,0.5)', borderRadius: 2, transition: 'all 300ms' }} />
                  {balAfter && <div style={{ position: 'absolute', left: '12%', right: '12%', top: Math.min(y(o), 35), height: Math.max(1, Math.abs(y(o) - 35)), border: '1px dashed #9ca3af', borderRadius: 2 }} />}
                  <div style={{ position: 'absolute', left: 0, right: 0, top: y(t), height: 2, background: 'var(--green)' }} />
                  <div style={{ position: 'absolute', left: 0, right: 0, top: 35, height: 1, background: 'rgba(255,255,255,0.15)' }} />
                </div>
              )
            })}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${BANDS.length}, 1fr)`, gap: 4, fontSize: 9, color: 'var(--text-muted)', textAlign: 'center' }}>
            {BANDS.map((b) => { const d = (balAfter ?? bal.song)[b.id] - bal.target[b.id]; return <span key={b.id}>{bandLabel(b.id, lang)}<br /><span style={{ color: Math.abs(d) <= 2 ? 'var(--green)' : undefined }}>{(d > 0 ? '+' : '') + d.toFixed(1)}</span></span> })}
          </div>
        </div>
      )}

      {list && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {list.map((s) => {
            const done = (s as Suggestion & { applied?: boolean }).applied
            return (
              <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, background: done ? 'rgba(34,197,94,0.10)' : 'var(--bg-tertiary)', borderRadius: 6, padding: '6px 8px', opacity: s.area === 'note' ? 0.85 : 1 }}>
                {s.area !== 'note' ? <input type="checkbox" checked={s.on} disabled={done} onChange={() => tick(s.id)} title={tr('Tick to apply it with "Apply all ticked"')} style={{ accentColor: 'var(--accent)' }} /> : <span style={{ width: 13 }}>ⓘ</span>}
                <span style={{ fontSize: 10, color: 'var(--accent-light)', minWidth: 62, textTransform: 'uppercase' }}>{AREA[s.area]}</span>
                <span style={{ flex: 1, color: done ? 'var(--green)' : 'var(--text-primary)' }}>{done ? '✓ ' : ''}{s.text}</span>
                {s.area !== 'note' && (done
                  ? <span style={{ fontSize: 11, color: 'var(--green)', whiteSpace: 'nowrap' }}>{tr('applied')}</span>
                  : <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px', whiteSpace: 'nowrap', border: '1px solid var(--accent)' }} onClick={() => applyIds([s.id])}>{tr('Apply')}</button>)}
              </div>
            )
          })}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setList(list.map((s) => ({ ...s, on: s.area !== 'note' && !(s as Suggestion & { applied?: boolean }).applied })))}>{tr('Tick all')}</button>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setList(list.map((s) => ({ ...s, on: false })))}>{tr('None')}</button>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{tr('Compare with Before / After afterwards; every control stays adjustable.')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
