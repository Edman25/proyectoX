/**
 * Vista de una pista: encabezado del patrón (largo, rejilla, swing,
 * cuantizar) y el editor (grilla de pasos o piano roll).
 */
import { useState } from 'react'
import { gridTicks, ticksPerBar, type DrumRackTrack, type NoteId, type SlicerTrack } from '../model'
import { useApp, useProject } from '../state/store'
import { clearPattern, quantizeTrack, setNotesVelocity, setPatternBars, setSwing } from '../state/trackActions'
import { Fader } from './Fader'
import { NumberField } from './NumberField'
import { PianoRoll } from './PianoRoll'
import { StepGrid } from './StepGrid'

const RESOLUTIONS = [
  { label: '1/8', ticks: gridTicks(8) },
  { label: '1/16', ticks: gridTicks(16) },
  { label: '1/32', ticks: gridTicks(32) },
  { label: '1/8T', ticks: gridTicks(8, true) },
  { label: '1/16T', ticks: gridTicks(16, true) },
]

export function TrackView({ track }: { track: DrumRackTrack | SlicerTrack }) {
  const pattern = useProject((p) => (track.activePatternId ? p.patterns[track.activePatternId] : undefined))
  const ts = useProject((p) => p.timeSignature)
  const stepTicks = useApp((s) => s.ui.stepTicks)
  const editor = useApp((s) => s.ui.trackEditor)
  const setUi = useApp((s) => s.setUi)
  const [strength, setStrength] = useState(1)
  const [selection, setSelection] = useState<Set<NoteId>>(new Set())

  if (!pattern) return <p className="muted">Esta pista no tiene patrón.</p>

  const barTicks = ticksPerBar(ts)
  const bars = Math.max(1, Math.round(pattern.lengthTicks / barTicks))
  const live = pattern.notes.filter((n) => selection.has(n.id))
  const selectedIds = live.map((n) => n.id)
  const firstVelocity = live[0]?.velocity

  return (
    <section className="sequencer">
      <header className="editor-head">
        <h2>{track.name}</h2>
        <span className="meta">{track.kind === 'drumRack' ? 'Drum Rack' : 'Slicer'}</span>
        <nav className="segmented">
          <button className={editor === 'steps' ? 'active' : ''} onClick={() => setUi({ trackEditor: 'steps' })}>
            Pasos
          </button>
          <button className={editor === 'roll' ? 'active' : ''} onClick={() => setUi({ trackEditor: 'roll' })}>
            Piano roll
          </button>
        </nav>
        <div className="spacer" />
        <label className="field">
          <span>Largo</span>
          <select value={bars} onChange={(e) => setPatternBars(track.id, Number(e.target.value))}>
            {[1, 2, 4, 8].map((b) => (
              <option key={b} value={b}>
                {b} {b === 1 ? 'compás' : 'compases'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Rejilla</span>
          <select value={stepTicks} onChange={(e) => setUi({ stepTicks: Number(e.target.value) })}>
            {RESOLUTIONS.map((r) => (
              <option key={r.label} value={r.ticks}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field" title="Swing: 0 = recto, 50 % ≈ tresillo">
          <span>Swing</span>
          <Fader value={pattern.swing} min={0} max={1} step={0.01} title="Swing" onCommit={(v) => setSwing(track.id, v)} />
          <span className="unit">{Math.round(pattern.swing * 100)}%</span>
        </label>
      </header>

      <div className="toolbar">
        <div className="tool-group">
          <span className="group-label">Cuantizar</span>
          <select value={strength} title="Intensidad" onChange={(e) => setStrength(Number(e.target.value))}>
            {[1, 0.75, 0.5, 0.25].map((v) => (
              <option key={v} value={v}>
                {v * 100}%
              </option>
            ))}
          </select>
          <button
            disabled={!pattern.notes.length}
            title="Cuantiza a la rejilla elegida, siempre desde el timing grabado (se puede repetir con otra intensidad)"
            onClick={() => quantizeTrack(track.id, stepTicks, strength, editor === 'roll' && selectedIds.length ? selectedIds : undefined)}
          >
            {editor === 'roll' && selectedIds.length ? `Cuantizar ${selectedIds.length}` : 'Cuantizar todo'}
          </button>
        </div>
        {editor === 'roll' && firstVelocity !== undefined && (
          <div className="tool-group">
            <NumberField
              label="Velocity"
              value={firstVelocity}
              min={1}
              max={127}
              onCommit={(v) => setNotesVelocity(track.id, selectedIds, v)}
            />
          </div>
        )}
        <div className="tool-group">
          <button disabled={!pattern.notes.length} onClick={() => clearPattern(track.id)}>
            Borrar notas
          </button>
          <span className="muted small">{pattern.notes.length} notas</span>
        </div>
      </div>

      {editor === 'steps' ? (
        <StepGrid track={track} pattern={pattern} />
      ) : (
        <PianoRoll track={track} pattern={pattern} selection={selection} setSelection={setSelection} />
      )}
    </section>
  )
}
