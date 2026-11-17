import React from 'react'
import { useProjectStore } from '../../stores/project.store'
import { useAudioStore } from '../../stores/audio.store'
import { tr } from '../../i18n/tr'

export function StatusBar(): React.ReactElement {
  const { project } = useProjectStore()
  const { currentBeat, bpm, isPlaying } = useAudioStore()

  const beats = Math.floor(currentBeat)
  const sub = Math.floor((currentBeat - beats) * 4) + 1

  return (
    <footer style={{
      height: 24,
      background: 'var(--bg-secondary)',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      gap: 16,
      fontSize: 11,
      color: 'var(--text-muted)'
    }}>
      <span style={{ color: isPlaying ? 'var(--success)' : 'var(--text-muted)' }}>
        {isPlaying ? tr('▶ Playing') : tr('■ Stopped')}
      </span>
      <span>{beats + 1}:{sub} / {bpm} BPM</span>
      <span>{project.tracks.length} {tr('track')}{project.tracks.length !== 1 ? 's' : ''}</span>
      <span>{project.sampleRate} Hz</span>
      <span style={{ flex: 1 }} />
      <span>{tr('AI Music Studio v0.1.0')}</span>
    </footer>
  )
}
