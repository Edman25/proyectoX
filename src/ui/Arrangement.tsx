/**
 * Arreglo: la canción como clips en una línea de tiempo, una fila por pista.
 *
 *  - doble clic en una fila: clip nuevo (patrón activo de la pista, o en una
 *    pista de audio, el sample/slice seleccionado en la biblioteca)
 *  - arrastrar un clip: mover (por compás; Alt: por tiempo), también a otra fila
 *  - borde derecho: largo (el patrón se repite dentro del clip)
 *  - regla: clic = desde dónde arranca el play · arrastrar = región de loop
 *  - Supr: borrar · Ctrl/Cmd+D: duplicar
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { PPQ, ticksPerBar, type ArrangementClip, type ClipId, type Project, type TrackId } from '../model'
import {
  addAudioClip,
  addAudioTrack,
  addPatternClip,
  deleteClips,
  duplicateClips,
  moveClips,
  patternsOf,
  resizeClip,
  selectPattern,
  setClipPattern,
  setSongLoop,
  setTransportMode,
  snapTick,
  updateAudioClip,
} from '../state/arrangeActions'
import { useApp, useProject } from '../state/store'
import { selectTrack } from '../state/trackActions'
import { NumberField } from './NumberField'
import { refLabel } from './pads'
import { usePlayhead } from './transport'

const LANE_H = 46
const HEAD_W = 140
const RULER_H = 24
const EDGE_PX = 7

interface Drag {
  mode: 'move' | 'resize'
  x0: number
  y0: number
  ids: ClipId[]
  dTicks: number
  dLanes: number
}

function clipLabel(p: Project, c: ArrangementClip): string {
  if (c.kind === 'pattern') return p.patterns[c.patternId]?.name ?? '(patrón borrado)'
  return refLabel(p, c.sample) ?? '(audio)'
}

function ClipInspector({ project, clip }: { project: Project; clip: ArrangementClip }) {
  const track = project.tracks[clip.trackId]
  if (clip.kind === 'pattern') {
    return (
      <div className="toolbar">
        <span className="group-label">Clip de {track?.name}</span>
        <label className="field">
          <span>Patrón</span>
          <select value={clip.patternId} onChange={(e) => setClipPattern(clip.id, e.target.value as typeof clip.patternId)}>
            {patternsOf(project, clip.trackId).map((pt) => (
              <option key={pt.id} value={pt.id}>
                {pt.name}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            selectPattern(clip.trackId, clip.patternId)
            selectTrack(clip.trackId)
          }}
        >
          Editar patrón
        </button>
      </div>
    )
  }
  const asset = project.assets[clip.sample.assetId]
  return (
    <div className="toolbar">
      <span className="group-label">Clip de audio</span>
      <label className="field" title="Off: tal cual. Resample: sigue el tempo cambiando el tono. Mantener tono: sigue el tempo sin cambiar el tono.">
        <span>Warp</span>
        <select value={clip.warp.mode} onChange={(e) => updateAudioClip(clip.id, 'Warp', (c) => void (c.warp.mode = e.target.value as typeof c.warp.mode))}>
          <option value="off">off</option>
          <option value="resample">resample</option>
          <option value="preserve">mantener tono</option>
        </select>
      </label>
      <NumberField
        label="BPM origen"
        value={clip.warp.sourceBpm ?? asset?.bpm ?? 0}
        min={0}
        max={300}
        step={0.01}
        width={70}
        onCommit={(v) => updateAudioClip(clip.id, 'BPM de origen', (c) => void (c.warp.sourceBpm = v > 0 ? v : null))}
      />
      {clip.warp.mode !== 'resample' && (
        <NumberField label="Tono" unit="st" value={clip.warp.semitones} min={-24} max={24} step={1} onCommit={(v) => updateAudioClip(clip.id, 'Tono del clip', (c) => void (c.warp.semitones = v))} />
      )}
      <NumberField label="Ganancia" unit="dB" value={clip.gainDb} min={-48} max={12} step={0.5} onCommit={(v) => updateAudioClip(clip.id, 'Ganancia del clip', (c) => void (c.gainDb = v))} />
      {clip.warp.mode !== 'off' && !(clip.warp.sourceBpm ?? asset?.bpm) && <span className="toast small">Sin BPM de origen: suena sin ajustar.</span>}
    </div>
  )
}

export function Arrangement() {
  const project = useProject((p) => p)
  const ui = useApp((s) => s.ui)
  const setUi = useApp((s) => s.setUi)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [wrapW, setWrapW] = useState(900)
  const [zoom, setZoom] = useState(1)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [rulerDrag, setRulerDrag] = useState<{ x0: number; x1: number } | null>(null)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const barTicks = ticksPerBar(project.timeSignature)
  const clips = Object.values(project.clips)
  const songEnd = Math.max(0, ...clips.map((c) => c.startTick + c.lengthTicks), project.songLoop.endTick)
  const bars = Math.max(16, Math.ceil(songEnd / barTicks) + 8)
  const pxPerTick = (Math.max(24, (wrapW - HEAD_W - 20) / 16) * zoom) / barTicks
  const width = bars * barTicks * pxPerTick
  const lanes = project.trackOrder.filter((id) => project.tracks[id])
  const laneOf = new Map(lanes.map((id, i) => [id, i]))
  const song = project.transportMode === 'song'

  const playX = usePlayhead(useCallback((tick: number, countingIn: boolean) => (countingIn ? null : Math.round(tick * pxPerTick)), [pxPerTick]))

  const shown = (c: ArrangementClip) => {
    const lane = laneOf.get(c.trackId) ?? 0
    if (!drag || !drag.ids.includes(c.id)) return { start: c.startTick, len: c.lengthTicks, lane }
    if (drag.mode === 'resize') return { start: c.startTick, len: Math.max(PPQ / 4, c.lengthTicks + drag.dTicks), lane }
    return { start: Math.max(0, c.startTick + drag.dTicks), len: c.lengthTicks, lane: Math.min(lanes.length - 1, Math.max(0, lane + drag.dLanes)) }
  }

  const onClipDown = (e: React.PointerEvent, c: ArrangementClip) => {
    e.stopPropagation()
    if (e.button !== 0) return
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const has = ui.selectedClipIds.includes(c.id)
      setUi({ selectedClipIds: has ? ui.selectedClipIds.filter((x) => x !== c.id) : [...ui.selectedClipIds, c.id] })
      return
    }
    const ids = ui.selectedClipIds.includes(c.id) ? ui.selectedClipIds : [c.id]
    if (!ui.selectedClipIds.includes(c.id)) setUi({ selectedClipIds: ids })
    const rect = e.currentTarget.getBoundingClientRect()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ mode: rect.right - e.clientX <= EDGE_PX ? 'resize' : 'move', x0: e.clientX, y0: e.clientY, ids, dTicks: 0, dLanes: 0 })
  }

  const onClipMove = (e: React.PointerEvent) => {
    if (!drag) return
    const grid = drag.mode === 'resize' || e.altKey ? PPQ : barTicks
    const dTicks = Math.round((e.clientX - drag.x0) / pxPerTick / grid) * grid
    const dLanes = drag.mode === 'move' ? Math.round((e.clientY - drag.y0) / LANE_H) : 0
    if (dTicks !== drag.dTicks || dLanes !== drag.dLanes) setDrag({ ...drag, dTicks, dLanes })
  }

  const onClipUp = () => {
    if (!drag) return
    if (drag.dTicks || drag.dLanes) {
      if (drag.mode === 'resize') {
        for (const id of drag.ids) {
          const c = project.clips[id]
          if (c) resizeClip(id, c.lengthTicks + drag.dTicks)
        }
      } else {
        moveClips(
          drag.ids.flatMap((id) => {
            const c = project.clips[id]
            if (!c) return []
            const s = shown(c)
            return [{ id, startTick: s.start, trackId: lanes[s.lane] }]
          }),
        )
      }
    }
    setDrag(null)
  }

  const onLaneDoubleClick = (e: React.MouseEvent, trackId: TrackId) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left
    const tick = x / pxPerTick
    const track = project.tracks[trackId]
    if (track?.kind === 'audio') {
      const asset = ui.selectedAssetId ? project.assets[ui.selectedAssetId] : undefined
      if (!asset) return
      const sliceId = ui.selectedSliceIds.length === 1 ? ui.selectedSliceIds[0] : undefined
      addAudioClip(trackId, sliceId ? { kind: 'slice', assetId: asset.id, sliceId } : { kind: 'asset', assetId: asset.id }, Math.floor(tick / PPQ) * PPQ)
    } else addPatternClip(trackId, tick)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!ui.selectedClipIds.length) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      deleteClips(ui.selectedClipIds)
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      duplicateClips(ui.selectedClipIds)
    }
  }

  const rulerUp = () => {
    if (!rulerDrag) return
    const a = rulerDrag.x0 / pxPerTick
    const b = rulerDrag.x1 / pxPerTick
    if (Math.abs(rulerDrag.x1 - rulerDrag.x0) > 6) {
      const start = snapTick(Math.min(a, b), barTicks)
      const end = Math.max(start + barTicks, snapTick(Math.max(a, b), barTicks))
      setSongLoop({ enabled: true, startTick: start, endTick: end })
    } else {
      setUi({ songStartTick: snapTick(a, PPQ) })
    }
    setRulerDrag(null)
  }

  const selectedClip = ui.selectedClipIds.length === 1 ? project.clips[ui.selectedClipIds[0]!] : undefined
  const loop = project.songLoop

  return (
    <section className="arrangement">
      <header className="editor-head">
        <h2>Arreglo</h2>
        <nav className="segmented" title="Patrón: cada pista loopea su patrón. Canción: suena la línea de tiempo.">
          <button className={!song ? 'active' : ''} onClick={() => setTransportMode('pattern')}>
            Modo patrón
          </button>
          <button className={song ? 'active' : ''} onClick={() => setTransportMode('song')}>
            Modo canción
          </button>
        </nav>
        {!song && <span className="toast small">El play toca patrones; cambia a "Modo canción" para oír el arreglo.</span>}
        <div className="spacer" />
        <label className="check" title="Arrastra sobre la regla para marcar la región">
          <input type="checkbox" checked={loop.enabled} disabled={loop.endTick <= loop.startTick} onChange={(e) => setSongLoop({ enabled: e.target.checked })} />
          Loop {loop.endTick > loop.startTick ? `compases ${Math.floor(loop.startTick / barTicks) + 1}–${Math.ceil(loop.endTick / barTicks)}` : ''}
        </label>
        <label className="field">
          <span>Zoom</span>
          <input type="range" min={0.5} max={4} step={0.25} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
        <button onClick={() => addAudioTrack()}>+ Pista de audio</button>
      </header>

      <div className="arr-wrap" ref={wrapRef}>
        <div className="arr" tabIndex={0} onKeyDown={onKeyDown}>
          <div className="arr-heads" style={{ width: HEAD_W }}>
            <div className="arr-ruler-head" style={{ height: RULER_H }} />
            {lanes.map((id) => {
              const t = project.tracks[id]!
              return (
                <button key={id} className={`arr-head ${ui.selectedTrackId === id ? 'active' : ''}`} style={{ height: LANE_H }} onClick={() => setUi({ selectedTrackId: id })}>
                  <span className="dot" style={{ background: t.color }} />
                  <span className="name">{t.name}</span>
                </button>
              )
            })}
          </div>
          <div className="arr-scroll">
            <div style={{ width, position: 'relative' }}>
              <div
                className="arr-ruler"
                style={{ height: RULER_H }}
                onPointerDown={(e) => {
                  const x = e.clientX - e.currentTarget.getBoundingClientRect().left
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setRulerDrag({ x0: x, x1: x })
                }}
                onPointerMove={(e) => rulerDrag && setRulerDrag({ ...rulerDrag, x1: e.clientX - e.currentTarget.getBoundingClientRect().left })}
                onPointerUp={rulerUp}
              >
                {Array.from({ length: bars }, (_, b) => (
                  <span key={b} className="bar-num" style={{ left: b * barTicks * pxPerTick }}>
                    {b + 1}
                  </span>
                ))}
                {loop.endTick > loop.startTick && (
                  <div className={`loop-region ${loop.enabled ? 'on' : ''}`} style={{ left: loop.startTick * pxPerTick, width: (loop.endTick - loop.startTick) * pxPerTick }} />
                )}
                {rulerDrag && Math.abs(rulerDrag.x1 - rulerDrag.x0) > 6 && (
                  <div className="loop-region on" style={{ left: Math.min(rulerDrag.x0, rulerDrag.x1), width: Math.abs(rulerDrag.x1 - rulerDrag.x0) }} />
                )}
                <div className="start-marker" style={{ left: ui.songStartTick * pxPerTick }} title="Aquí arranca el play" />
              </div>
              <div
                className="arr-body"
                style={{ height: lanes.length * LANE_H, backgroundSize: `${barTicks * pxPerTick}px 100%, ${PPQ * pxPerTick}px 100%, 100% ${LANE_H}px` }}
                onPointerDown={(e) => e.target === e.currentTarget && setUi({ selectedClipIds: [] })}
              >
                {lanes.map((id, i) => (
                  <div key={id} className="arr-lane" style={{ top: i * LANE_H, height: LANE_H }} onDoubleClick={(e) => onLaneDoubleClick(e, id)} />
                ))}
                {clips.map((c) => {
                  if (!laneOf.has(c.trackId)) return null
                  const s = shown(c)
                  const pattern = c.kind === 'pattern' ? project.patterns[c.patternId] : undefined
                  const t = project.tracks[c.trackId]!
                  return (
                    <div
                      key={c.id}
                      className={`arr-clip ${c.kind} ${ui.selectedClipIds.includes(c.id) ? 'selected' : ''}`}
                      style={{ left: s.start * pxPerTick, top: s.lane * LANE_H + 3, width: Math.max(6, s.len * pxPerTick - 1), height: LANE_H - 6, ['--clip' as string]: t.color }}
                      onPointerDown={(e) => onClipDown(e, c)}
                      onPointerMove={onClipMove}
                      onPointerUp={onClipUp}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        if (c.kind === 'pattern') {
                          selectPattern(c.trackId, c.patternId)
                          selectTrack(c.trackId)
                        }
                      }}
                      title={clipLabel(project, c)}
                    >
                      <span className="clip-name">{clipLabel(project, c)}</span>
                      {pattern &&
                        pattern.lengthTicks > 0 &&
                        Array.from({ length: Math.ceil(s.len / pattern.lengthTicks) - 1 }, (_, k) => (
                          <span key={k} className="clip-repeat" style={{ left: (k + 1) * pattern.lengthTicks * pxPerTick }} />
                        ))}
                      {c.kind === 'audio' && c.warp.semitones !== 0 && <span className="clip-tag">{c.warp.semitones > 0 ? '+' : ''}{c.warp.semitones} st</span>}
                    </div>
                  )
                })}
                {playX !== null && song && <div className="roll-playhead" style={{ left: playX }} />}
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedClip ? (
        <ClipInspector project={project} clip={selectedClip} />
      ) : (
        <p className="wave-hint">
          Doble clic en una fila: clip (en pistas de audio usa el sample o slice seleccionado en la biblioteca{ui.selectedAssetId ? `: ${project.assets[ui.selectedAssetId]?.name ?? ''}` : ''}) · Arrastrar: mover por compás (Alt: por tiempo) · Borde derecho: largo · Regla: clic = inicio, arrastrar = loop · Supr: borrar · Ctrl/Cmd+D: duplicar
        </p>
      )}
      {lanes.length === 0 && <p className="muted">Crea pistas a la izquierda para empezar el arreglo.</p>}
    </section>
  )
}
