import React, { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/project.store'
import { saveProject } from '../../project/io'
import { tr, trf } from '../../i18n/tr'

// Closing the app with unsaved changes: ask whether to save the project first (Save / Don't save / Cancel).
// The main process holds the window open until the page answers; without changes it closes at once.
export function CloseGuard(): React.ReactElement | null {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const name = useProjectStore((s) => s.project.name)

  useEffect(() => {
    const app = window.api?.app
    if (!app) return undefined
    const off = app.onCloseRequest?.(() => {
      if (!useProjectStore.getState().dirty) void app.closeConfirmed()
      else setAsking(true)
    })
    return typeof off === 'function' ? off : undefined
  }, [])

  if (!asking) return null
  const close = (): void => { setAsking(false); void window.api.app?.closeConfirmed() }
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      if (await saveProject()) close()        // the save dialog was cancelled: stay open
    } catch (e) {
      window.alert(trf('Saving failed: {m}', { m: (e as Error).message }))
    } finally { setBusy(false) }
  }
  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 440, background: 'var(--bg-elevated)', border: '1px solid var(--border-mid)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}
        onKeyDown={(e) => { if (e.key === 'Escape') setAsking(false) }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{tr('Save the project before closing?')}</span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {trf('“{name}” has changes that are not saved yet. Without saving they are lost.', { name })}
        </span>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setAsking(false)}>{tr('Cancel')}</button>
          <button className="btn btn-ghost" disabled={busy} onClick={close}>{tr("Don't save")}</button>
          <button className="btn btn-primary" autoFocus disabled={busy} onClick={() => void save()}>{busy ? tr('Saving…') : tr('Save')}</button>
        </div>
      </div>
    </div>
  )
}
