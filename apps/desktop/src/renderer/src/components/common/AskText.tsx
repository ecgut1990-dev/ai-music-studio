import React, { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

// A small dialog that asks for a text (window.prompt does not work in Electron): askText(...) resolves to the text,
// or null when the dialog is cancelled. <AskTextDialog /> is mounted once in App.

interface Ask { title: string; label: string; value: string; ok: string; resolve: (v: string | null) => void }
const useAsk = create<{ ask: Ask | null }>()(() => ({ ask: null }))

export function askText(title: string, label: string, value = '', ok = 'OK'): Promise<string | null> {
  return new Promise((resolve) => useAsk.setState({ ask: { title, label, value, ok, resolve } }))
}

export function AskTextDialog(): React.ReactElement | null {
  const ask = useAsk((s) => s.ask)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ask) { setText(ask.value); setTimeout(() => input.current?.select(), 30) } }, [ask])
  if (!ask) return null
  const done = (v: string | null): void => { useAsk.setState({ ask: null }); ask.resolve(v) }
  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) done(null) }}>
      <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) done(text.trim()) }}
        style={{ width: 420, background: 'var(--bg-elevated)', border: '1px solid var(--border-mid)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{ask.title}</span>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          {ask.label}
          <input ref={input} value={text} onChange={(e) => setText(e.target.value)} autoFocus style={{ fontSize: 13 }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); done(null) } }} />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={() => done(null)}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!text.trim()}>{ask.ok}</button>
        </div>
      </form>
    </div>
  )
}
