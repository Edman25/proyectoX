/**
 * Grilla de pasos: cada fila es un pad (Drum Rack) o un slice (Slicer); cada
 * columna, un paso. Es una vista del patrón: una nota que no cae justo en la
 * rejilla (p. ej. grabada) se ve en el paso que la contiene.
 */
import { useCallback, useMemo } from 'react'
import { liveNoteOff, liveNoteOn } from '../audio/engineHost'
import { PPQ, type DrumRackTrack, type Pattern, type Project, type SampleRef, type SlicerTrack } from '../model'
import { useApp, useProject } from '../state/store'
import { assignPad, setChokeGroup, setPadTrigger, toggleStep } from '../state/trackActions'
import { refLabel } from './pads'
import { rowsFor } from './rows'
import { usePlayhead } from './transport'

function encodeRef(ref: SampleRef | null): string {
  return ref ? JSON.stringify(ref) : ''
}

export function SampleSelect({ project, value, onChange }: { project: Project; value: SampleRef | null; onChange: (r: SampleRef | null) => void }) {
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

export function StepGrid({ track, pattern }: { track: DrumRackTrack | SlicerTrack; pattern: Pattern }) {
  const project = useProject((p) => p)
  const stepTicks = useApp((s) => s.ui.stepTicks)
  const length = pattern.lengthTicks
  const steps = Math.max(1, Math.round(length / stepTicks))
  const stepsPerBeat = Math.max(1, Math.round(PPQ / stepTicks))

  const currentStep = usePlayhead(
    useCallback((tick: number, countingIn: boolean) => (countingIn ? -1 : Math.floor((((tick % length) + length) % length) / stepTicks)), [length, stepTicks]),
  )

  const rows = rowsFor(project, track)
  const active = new Map<number, Map<number, number>>()
  for (const n of pattern.notes) {
    if (n.tick < 0 || n.tick >= length) continue
    const step = Math.floor(n.tick / stepTicks)
    let m = active.get(n.pitch)
    if (!m) active.set(n.pitch, (m = new Map()))
    m.set(step, Math.max(m.get(step) ?? 0, n.velocity))
  }

  if (rows.length === 0) return <p className="muted">Este Slicer no tiene slices: corta su sample en la pestaña Sample.</p>

  return (
    <div className="grid-scroll">
      <table className="step-grid">
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
                  const vel = on?.get(s)
                  const classes = ['step']
                  if (vel) classes.push('on')
                  if (s % stepsPerBeat === 0) classes.push('beat')
                  if (s === currentStep) classes.push('now')
                  return (
                    <td key={s}>
                      <button
                        className={classes.join(' ')}
                        style={vel ? { opacity: 0.35 + (0.65 * vel) / 127 } : undefined}
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
  )
}
