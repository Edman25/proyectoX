/**
 * Piano roll: el mismo patrón que la grilla de pasos, pero con las notas en
 * su tiempo y duración reales. Aquí se ve (y se corrige) lo grabado.
 *
 *  - doble clic en un hueco: nota nueva (un paso de largo)
 *  - clic en una nota: seleccionar (Shift/Ctrl/Cmd: sumar)
 *  - arrastrar una nota: mover (en saltos de la rejilla; Alt: libre)
 *  - arrastrar el borde derecho: cambiar duración
 *  - Supr/Retroceso: borrar · Ctrl/Cmd+A: seleccionar todo
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { liveNoteOff, liveNoteOn } from '../audio/engineHost'
import { PPQ, type DrumRackTrack, type Note, type NoteId, type Pattern, type SlicerTrack } from '../model'
import { useApp, useProject } from '../state/store'
import { addNote, deleteNotes, editNotes, type NoteEdit } from '../state/trackActions'
import { rowsFor } from './rows'
import { usePlayhead } from './transport'

const ROW_H = 24
const HEAD_W = 120
const EDGE_PX = 6
const MIN_STEP_PX = 26

interface Drag {
  mode: 'move' | 'resize'
  x0: number
  y0: number
  ids: NoteId[]
  dTicks: number
  dRows: number
  free: boolean
}

export function PianoRoll({
  track,
  pattern,
  selection,
  setSelection,
}: {
  track: DrumRackTrack | SlicerTrack
  pattern: Pattern
  selection: ReadonlySet<NoteId>
  setSelection: (s: Set<NoteId>) => void
}) {
  const project = useProject((p) => p)
  const stepTicks = useApp((s) => s.ui.stepTicks)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [wrapW, setWrapW] = useState(800)
  const [drag, setDrag] = useState<Drag | null>(null)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const length = pattern.lengthTicks
  const rows = rowsFor(project, track)
  const rowOf = new Map(rows.map((r, i) => [r.pitch, i]))
  const stepPx = Math.max(MIN_STEP_PX, (wrapW - HEAD_W - 16) / Math.max(1, length / stepTicks))
  const pxPerTick = stepPx / stepTicks
  const width = length * pxPerTick
  const beatPx = PPQ * pxPerTick

  const playX = usePlayhead(
    useCallback((tick: number, countingIn: boolean) => (countingIn ? null : Math.round((((tick % length) + length) % length) * pxPerTick)), [length, pxPerTick]),
  )

  // Notas con el arrastre en curso aplicado (solo visual hasta soltar).
  const shown = (n: Note): { tick: number; dur: number; row: number } | null => {
    const row = rowOf.get(n.pitch)
    if (row === undefined) return null
    if (!drag || !drag.ids.includes(n.id)) return { tick: n.tick, dur: n.durationTicks, row }
    if (drag.mode === 'resize') return { tick: n.tick, dur: Math.max(stepTicks / 4, n.durationTicks + drag.dTicks), row }
    return { tick: n.tick + drag.dTicks, dur: n.durationTicks, row: Math.min(rows.length - 1, Math.max(0, row + drag.dRows)) }
  }

  const snapDelta = (dx: number, free: boolean) => {
    const t = dx / pxPerTick
    return free ? Math.round(t) : Math.round(t / stepTicks) * stepTicks
  }

  const onNoteDown = (e: React.PointerEvent, n: Note) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const resize = rect.right - e.clientX <= EDGE_PX
    let sel = selection
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const next = new Set(selection)
      if (next.has(n.id)) next.delete(n.id)
      else next.add(n.id)
      setSelection(next)
      return
    }
    if (!selection.has(n.id)) {
      sel = new Set([n.id])
      setSelection(sel as Set<NoteId>)
    }
    const row = rows[rowOf.get(n.pitch) ?? -1]
    if (row && !resize) liveNoteOn({ trackId: track.id, pitch: row.pitch }, n.velocity, e.timeStamp)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ mode: resize ? 'resize' : 'move', x0: e.clientX, y0: e.clientY, ids: [...sel], dTicks: 0, dRows: 0, free: e.altKey })
  }

  const onNoteMove = (e: React.PointerEvent) => {
    if (!drag) return
    const dTicks = snapDelta(e.clientX - drag.x0, e.altKey)
    const dRows = drag.mode === 'move' ? Math.round((e.clientY - drag.y0) / ROW_H) : 0
    if (dTicks !== drag.dTicks || dRows !== drag.dRows) setDrag({ ...drag, dTicks, dRows, free: e.altKey })
  }

  const onNoteUp = (e: React.PointerEvent, n: Note) => {
    liveNoteOff({ trackId: track.id, pitch: n.pitch }, e.timeStamp)
    if (!drag) return
    if (drag.dTicks !== 0 || drag.dRows !== 0) {
      const edits: NoteEdit[] = []
      for (const note of pattern.notes) {
        if (!drag.ids.includes(note.id)) continue
        const s = shown(note)
        const row = s ? rows[s.row] : undefined
        if (!s || !row) continue
        edits.push({ id: note.id, tick: Math.max(0, Math.min(length - 1, s.tick)), durationTicks: s.dur, pitch: row.pitch })
      }
      editNotes(track.id, edits, drag.mode === 'resize' ? 'Duración' : 'Mover notas')
    }
    setDrag(null)
  }

  const localPos = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = localPos(e)
    const row = rows[Math.floor(y / ROW_H)]
    if (!row) return
    const tick = Math.floor(x / pxPerTick / stepTicks) * stepTicks
    if (tick < 0 || tick >= length) return
    const id = addNote(track.id, tick, stepTicks, row.pitch)
    if (id) setSelection(new Set([id]))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
      e.preventDefault()
      e.stopPropagation()
      deleteNotes(track.id, [...selection])
      setSelection(new Set())
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelection(new Set(pattern.notes.map((n) => n.id)))
    }
  }

  if (rows.length === 0) return <p className="muted">Este Slicer no tiene slices: corta su sample en la pestaña Sample.</p>

  return (
    <div className="roll-wrap" ref={wrapRef}>
      <div className="roll" tabIndex={0} onKeyDown={onKeyDown}>
        <div className="roll-heads" style={{ width: HEAD_W }}>
          {rows.map((r) => (
            <button
              key={r.pitch}
              className="roll-head"
              style={{ height: ROW_H }}
              title={r.label}
              onPointerDown={(e) => liveNoteOn({ trackId: track.id, pitch: r.pitch }, 100, e.timeStamp)}
              onPointerUp={(e) => liveNoteOff({ trackId: track.id, pitch: r.pitch }, e.timeStamp)}
            >
              <span className="num">{r.padIndex !== undefined ? r.padIndex + 1 : r.label.replace('Slice ', '')}</span>
              {r.padIndex !== undefined && <span className="muted">{r.label}</span>}
            </button>
          ))}
        </div>
        <div className="roll-scroll">
          <div
            className="roll-body"
            style={{
              width,
              height: rows.length * ROW_H,
              backgroundSize: `${beatPx}px 100%, ${stepPx}px 100%, 100% ${ROW_H}px`,
            }}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) setSelection(new Set())
            }}
            onDoubleClick={onDoubleClick}
          >
            {pattern.notes.map((n) => {
              const s = shown(n)
              if (!s || n.tick >= length) return null
              const classes = ['roll-note']
              if (selection.has(n.id)) classes.push('selected')
              if (n.recorded) classes.push('recorded')
              return (
                <div
                  key={n.id}
                  className={classes.join(' ')}
                  style={{
                    left: s.tick * pxPerTick,
                    top: s.row * ROW_H + 2,
                    width: Math.max(4, s.dur * pxPerTick - 1),
                    height: ROW_H - 4,
                    opacity: 0.45 + (0.55 * n.velocity) / 127,
                  }}
                  title={`velocity ${n.velocity}`}
                  onPointerDown={(e) => onNoteDown(e, n)}
                  onPointerMove={onNoteMove}
                  onPointerUp={(e) => onNoteUp(e, n)}
                />
              )
            })}
            {playX !== null && <div className="roll-playhead" style={{ left: playX }} />}
          </div>
        </div>
      </div>
      <p className="wave-hint">
        Doble clic: nota · Arrastrar: mover (Alt: sin rejilla) · Borde derecho: duración · Supr: borrar · Ctrl/Cmd+A: todo. Las notas grabadas sin cuantizar se ven con borde punteado.
      </p>
    </div>
  )
}
