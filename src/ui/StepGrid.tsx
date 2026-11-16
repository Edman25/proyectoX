/**
 * Secuenciador de pasos de la pista seleccionada. Cada fila es un pad (Drum
 * Rack) o un slice (Slicer); cada columna, un paso. Es una vista del patrón
 * (lista de notas): una nota que no cae justo en la rejilla se ve en el paso
 * que la contiene.
 */
import { useCallback, useMemo } from 'react'
import { liveNoteOff, liveNoteOn } from '../audio/engineHost'
import { PPQ, gridTicks, type DrumRackTrack, type Pattern, type Project, type SampleRef, type SlicerTrack } from '../model'
import { useApp, useProject } from '../state/store'
import { assignPad, clearPattern, setChokeGroup, setPatternBars, setPadTrigger, setSwing, toggleStep } from '../state/trackActions'
import { Fader } from './Fader'
import { refLabel } from './pads'
import { usePlayhead } from './transport'

const RESOLUTIONS = [
  { label: '1/8', ticks: gridTicks(8) },
  { label: '1/16', ticks: gridTicks(16) },
  { label: '1/32', ticks: gridTicks(32) },
  { label: '1/8T', ticks: gridTicks(8, true) },
  { label: '1/16T', ticks: gridTicks(16, true) },
]

function encodeRef(ref: SampleRef | null): string {
  return ref ? JSON.stringify(ref) : ''
}

function SampleSelect({ project, value, onChange }: { project: Project; value: SampleRef | null; onChange: (r: SampleRef | null) => void }) {
  const options = useMemo(() => {
    const out: { value: string; label: string }[] = []
    for (const a of Object.values(project.assets)) {
      out.push({ value: encodeRef({ kind: 'asset', assetId: a.id }), label: `${a.name} (completo)` })
      a.slices.forEach((s, i) => out.push({ value: encodeRef({ kind: 'slice', assetId: a.id, sliceId: s.id }), label: `${a.name} · ${i + 1}` }))
    }
    return out
  }, [project.assets])
  const current = encodeRef(value)
  const known = !value || options.some((o) => o.value === current)
  return (
    <select
      className="sample-select"
      value={current}
      onChange={(e) => onChange(e.target.value ? (JSON.parse(e.target.value) as SampleRef) : null)}
      onClick={(e) => e.stopPropagation()}
    >
      <option value="">— vacío —</option>
      {!known && <option value={current}>{refLabel(project, value)}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

interface Row {
  pitch: number
  label: string
  padIndex?: number
}

function rowsFor(project: Project, track: DrumRackTrack | SlicerTrack): Row[] {
  if (track.kind === 'drumRack') {
    return track.pads.map((pad, i) => ({ pitch: track.baseNote + i, label: refLabel(project, pad.sample) ?? '', padIndex: i }))
  }
  const asset = track.assetId ? project.assets[track.assetId] : undefined
  return (asset?.slices ?? []).map((_, i) => ({ pitch: track.baseNote + i, label: `Slice ${i + 1}` }))
}

export function StepGrid({ track }: { track: DrumRackTrack | SlicerTrack }) {
  const project = useProject((p) => p)
  const stepTicks = useApp((s) => s.ui.stepTicks)
  const setUi = useApp((s) => s.setUi)
  const pattern: Pattern | undefined = track.activePatternId ? project.patterns[track.activePatternId] : undefined
  const length = pattern?.lengthTicks ?? PPQ * 4
  const steps = Math.max(1, Math.round(length / stepTicks))
  const stepsPerBeat = Math.max(1, Math.round(PPQ / stepTicks))
  const barTicks = (PPQ * 4 * project.timeSignature.numerator) / project.timeSignature.denominator
  const bars = Math.max(1, Math.round(length / barTicks))

  const currentStep = usePlayhead(
    useCallback((tick: number, countingIn: boolean) => (countingIn ? -1 : Math.floor((((tick % length) + length) % length) / stepTicks)), [length, stepTicks]),
  )

  const rows = rowsFor(project, track)
  const active = new Map<number, Set<number>>()
  for (const n of pattern?.notes ?? []) {
    if (n.tick < 0 || n.tick >= length) continue
    const step = Math.floor(n.tick / stepTicks)
    let set = active.get(n.pitch)
    if (!set) active.set(n.pitch, (set = new Set()))
    set.add(step)
  }

  return (
    <section className="sequencer">
      <header className="editor-head">
        <h2>{track.name}</h2>
        <span className="meta">{track.kind === 'drumRack' ? 'Drum Rack' : 'Slicer'}</span>
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
          <span>Pasos</span>
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
          <Fader value={pattern?.swing ?? 0} min={0} max={1} step={0.01} title="Swing" onCommit={(v) => setSwing(track.id, v)} />
          <span className="unit">{Math.round((pattern?.swing ?? 0) * 100)}%</span>
        </label>
        <button disabled={!pattern?.notes.length} onClick={() => clearPattern(track.id)}>
          Borrar notas
        </button>
      </header>

      {rows.length === 0 ? (
        <p className="muted">Este Slicer no tiene slices: corta su sample en la pestaña Sample.</p>
      ) : (
        <div className="grid-scroll">
          <table className="step-grid" style={{ ['--steps' as string]: steps }}>
            <tbody>
              {rows.map((row) => {
                const on = active.get(row.pitch)
                const pad = row.padIndex !== undefined && track.kind === 'drumRack' ? track.pads[row.padIndex] : undefined
                return (
                  <tr key={row.pitch}>
                    <th>
                      <div className="row-head">
                        <button
                          className="audition"
                          title="Escuchar"
                          onPointerDown={(e) => liveNoteOn({ trackId: track.id, pitch: row.pitch }, 100, e.timeStamp)}
                          onPointerUp={(e) => liveNoteOff({ trackId: track.id, pitch: row.pitch }, e.timeStamp)}
                        >
                          {row.padIndex !== undefined ? row.padIndex + 1 : row.label}
                        </button>
                        {pad && row.padIndex !== undefined && (
                          <>
                            <SampleSelect project={project} value={pad.sample} onChange={(r) => assignPad(track.id, row.padIndex!, r)} />
                            <select
                              className="mini"
                              title="Choke: los pads del mismo grupo se cortan entre sí"
                              value={pad.chokeGroup ?? ''}
                              onChange={(e) => setChokeGroup(track.id, row.padIndex!, e.target.value === '' ? null : Number(e.target.value))}
                            >
                              <option value="">—</option>
                              {[1, 2, 3, 4].map((g) => (
                                <option key={g} value={g}>
                                  C{g}
                                </option>
                              ))}
                            </select>
                            <button
                              className={`mini ${pad.triggerMode === 'gate' ? 'on' : ''}`}
                              title={pad.triggerMode === 'gate' ? 'Gate: se corta al soltar' : 'One-shot: suena completo'}
                              onClick={() => setPadTrigger(track.id, row.padIndex!, pad.triggerMode === 'gate' ? 'oneShot' : 'gate')}
                            >
                              {pad.triggerMode === 'gate' ? 'G' : '1'}
                            </button>
                          </>
                        )}
                      </div>
                    </th>
                    {Array.from({ length: steps }, (_, s) => {
                      const classes = ['step']
                      if (on?.has(s)) classes.push('on')
                      if (s % stepsPerBeat === 0) classes.push('beat')
                      if (s === currentStep) classes.push('now')
                      return (
                        <td key={s}>
                          <button
                            className={classes.join(' ')}
                            aria-label={`Paso ${s + 1}`}
                            onClick={(e) => toggleStep(track.id, row.pitch, s * stepTicks, stepTicks, e.shiftKey ? 60 : 100)}
                          />
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="wave-hint">Clic: prender/apagar paso (Shift: suave) · Clic en el número de fila: escuchar · Espacio: play/stop</p>
    </section>
  )
}
