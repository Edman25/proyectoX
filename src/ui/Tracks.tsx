import { useState } from 'react'
import type { TrackId } from '../model'
import { useApp, useProject } from '../state/store'
import { addDrumRack, addSlicer, removeTrack, renameTrack, selectTrack, setMixer, toggleArm } from '../state/trackActions'
import { Fader } from './Fader'

const KIND_LABEL = { drumRack: 'Drum Rack', slicer: 'Slicer', sampler: 'Sampler', audio: 'Audio' } as const

export function Tracks() {
  const order = useProject((p) => p.trackOrder)
  const tracks = useProject((p) => p.tracks)
  const ui = useApp((s) => s.ui)
  const asset = useProject((p) => (ui.selectedAssetId ? p.assets[ui.selectedAssetId] : undefined))
  const [editing, setEditing] = useState<TrackId | null>(null)

  return (
    <div className="tracks">
      <header>
        <h2>Pistas</h2>
      </header>
      <div className="track-add">
        <button onClick={() => addDrumRack()}>+ Drum Rack</button>
        <button
          disabled={!asset || asset.slices.length === 0}
          title={asset?.slices.length ? `Slicer con los slices de ${asset.name}` : 'Selecciona un sample con slices'}
          onClick={() => asset && addSlicer(asset.id)}
        >
          + Slicer
        </button>
      </div>
      <ul>
        {order.map((id) => {
          const t = tracks[id]
          if (!t) return null
          const active = ui.view === 'track' && ui.selectedTrackId === id
          return (
            <li key={id} className={active ? 'active' : ''} onClick={() => selectTrack(id)}>
              <div className="track-row">
                <span className="dot" style={{ background: t.color }} />
                {editing === id ? (
                  <input
                    autoFocus
                    defaultValue={t.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      renameTrack(id, e.target.value)
                      setEditing(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <span className="name" onDoubleClick={() => setEditing(id)} title={`${t.name} · ${KIND_LABEL[t.kind]}`}>
                    {t.name}
                  </span>
                )}
                {t.kind !== 'audio' && (
                  <button
                    className={`ms arm ${t.armed ? 'on' : ''}`}
                    title="Armar para grabar"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleArm(id)
                    }}
                  >
                    ●
                  </button>
                )}
                <button
                  className={`ms ${t.mixer.mute ? 'on mute' : ''}`}
                  title="Mute"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMixer(id, { mute: !t.mixer.mute }, 'Mute')
                  }}
                >
                  M
                </button>
                <button
                  className={`ms ${t.mixer.solo ? 'on solo' : ''}`}
                  title="Solo"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMixer(id, { solo: !t.mixer.solo }, 'Solo')
                  }}
                >
                  S
                </button>
                <button
                  className="icon"
                  title="Quitar pista (se puede deshacer)"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeTrack(id)
                  }}
                >
                  ×
                </button>
              </div>
              <div className="track-row" onClick={(e) => e.stopPropagation()}>
                <span className="meta">{KIND_LABEL[t.kind]}</span>
                <Fader
                  value={t.mixer.volumeDb}
                  min={-40}
                  max={6}
                  step={0.5}
                  title="Volumen (dB, doble clic = 0)"
                  onCommit={(v) => setMixer(id, { volumeDb: v }, 'Volumen')}
                />
                <span className="meta db">{t.mixer.volumeDb > 0 ? '+' : ''}{t.mixer.volumeDb} dB</span>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
