/**
 * Editor de forma de onda: ver, hacer zoom, poner/mover/quitar marcadores y
 * seleccionar slices. Dibuja en canvas.
 *
 * Interacciones:
 *  - clic en un slice: seleccionar y escuchar (Shift: rango, Ctrl/Cmd: sumar)
 *  - doble clic: marcador nuevo
 *  - arrastrar un marcador: moverlo · Alt+clic en un marcador: quitarlo
 *  - rueda: zoom en el cursor · Shift+rueda o desplazamiento horizontal: moverse
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { peaksForView } from '../analysis/peaks'
import type { LoadedAudio } from '../audio/library'
import type { SampleAsset, Slice, SliceId } from '../model'
import { MIN_SLICE_FRAMES, moveEdge, sliceAt } from '../model/sliceOps'
import { addMarkerAt, moveSliceEdge, removeMarker, selectSlice } from '../state/actions'
import { previewFrom, previewPosition, previewSlice, usePreview } from './preview'

const MAIN_H = 240
const OVERVIEW_H = 40
const HIT_PX = 6

interface Edge {
  sliceId: SliceId
  edge: 'start' | 'end'
  frame: number
}

interface Props {
  asset: SampleAsset
  audio: LoadedAudio
  selected: readonly SliceId[]
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function edgesOf(slices: readonly Slice[]): Edge[] {
  const out: Edge[] = []
  slices.forEach((s, i) => {
    out.push({ sliceId: s.id, edge: 'start', frame: s.start })
    const next = slices[i + 1]
    if (!next || next.start !== s.end) out.push({ sliceId: s.id, edge: 'end', frame: s.end })
  })
  return out
}

export function Waveform({ asset, audio, selected }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLCanvasElement>(null)
  const overRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(800)
  const [view, setView] = useState({ start: 0, end: asset.frames })
  const [drag, setDrag] = useState<(Edge & { to: number }) | null>(null)
  const [hover, setHover] = useState<Edge | null>(null)
  const handle = usePreview((s) => (s.assetId === asset.id ? s.handle : null))

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const slices = drag ? moveEdge(asset.slices, asset.frames, drag.sliceId, drag.edge, drag.to) : asset.slices
  const span = view.end - view.start
  const xToFrame = useCallback((x: number) => view.start + (x / width) * span, [view.start, width, span])
  const frameToX = useCallback((f: number) => ((f - view.start) / span) * width, [view.start, width, span])

  // --- dibujo -------------------------------------------------------------
  const draw = useCallback(
    (playFrame: number | null) => {
      const c = mainRef.current
      const o = overRef.current
      if (!c || !o) return
      const dpr = window.devicePixelRatio || 1
      for (const [cv, h] of [
        [c, MAIN_H],
        [o, OVERVIEW_H],
      ] as const) {
        if (cv.width !== width * dpr || cv.height !== h * dpr) {
          cv.width = width * dpr
          cv.height = h * dpr
          cv.style.width = `${width}px`
          cv.style.height = `${h}px`
        }
      }
      const colors = {
        bg: cssVar('--wave-bg'),
        wave: cssVar('--wave'),
        sliceA: cssVar('--slice-a'),
        sliceB: cssVar('--slice-b'),
        selected: cssVar('--slice-selected'),
        marker: cssVar('--accent'),
        text: cssVar('--muted'),
        playhead: cssVar('--playhead'),
      }

      // Principal
      const g = c.getContext('2d')
      if (!g) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = colors.bg
      g.fillRect(0, 0, width, MAIN_H)
      const sel = new Set(selected)
      slices.forEach((s, i) => {
        const x0 = frameToX(s.start)
        const x1 = frameToX(s.end)
        if (x1 < 0 || x0 > width) return
        g.fillStyle = sel.has(s.id) ? colors.selected : i % 2 ? colors.sliceB : colors.sliceA
        g.fillRect(x0, 0, x1 - x0, MAIN_H)
      })
      const mid = MAIN_H / 2
      const { min, max } = peaksForView(audio.peaks, view.start, view.end, width)
      g.fillStyle = colors.wave
      for (let x = 0; x < width; x++) {
        const y0 = mid - max[x]! * mid * 0.95
        const y1 = mid - min[x]! * mid * 0.95
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0))
      }
      g.font = '11px system-ui, sans-serif'
      slices.forEach((s, i) => {
        const x = frameToX(s.start)
        if (x >= -20 && x <= width) {
          g.fillStyle = colors.marker
          g.fillRect(Math.round(x), 0, 1, MAIN_H)
          g.fillRect(Math.round(x), 0, 16, 14)
          g.fillStyle = colors.bg
          g.fillText(String(i + 1), Math.round(x) + 3, 11)
        }
      })
      for (const e of edgesOf(slices)) {
        if (e.edge !== 'end') continue
        const x = frameToX(e.frame)
        g.fillStyle = colors.marker
        g.fillRect(Math.round(x), 0, 1, MAIN_H)
      }
      if (hover && !drag) {
        g.fillStyle = colors.marker
        g.fillRect(Math.round(frameToX(hover.frame)) - 1, 0, 3, MAIN_H)
      }
      if (playFrame !== null) {
        g.fillStyle = colors.playhead
        g.fillRect(Math.round(frameToX(playFrame)), 0, 2, MAIN_H)
      }

      // Vista general
      const og = o.getContext('2d')
      if (!og) return
      og.setTransform(dpr, 0, 0, dpr, 0, 0)
      og.fillStyle = colors.bg
      og.fillRect(0, 0, width, OVERVIEW_H)
      const all = peaksForView(audio.peaks, 0, asset.frames, width)
      og.fillStyle = colors.text
      const om = OVERVIEW_H / 2
      for (let x = 0; x < width; x++) {
        const y0 = om - all.max[x]! * om
        og.fillRect(x, y0, 1, Math.max(1, om - all.min[x]! * om - y0))
      }
      const vx0 = (view.start / asset.frames) * width
      const vx1 = (view.end / asset.frames) * width
      og.strokeStyle = colors.marker
      og.lineWidth = 1
      og.strokeRect(vx0 + 0.5, 0.5, Math.max(2, vx1 - vx0) - 1, OVERVIEW_H - 1)
      if (playFrame !== null) {
        og.fillStyle = colors.playhead
        og.fillRect((playFrame / asset.frames) * width, 0, 1, OVERVIEW_H)
      }
    },
    [width, slices, selected, audio.peaks, view, frameToX, hover, drag, asset.frames],
  )

  // Redibujar; mientras suena el preview, en cada cuadro.
  useEffect(() => {
    if (!handle) {
      draw(null)
      return
    }
    let raf = 0
    const loop = () => {
      const pos = previewPosition(handle)
      draw(pos)
      if (pos !== null) raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [draw, handle])

  // --- interacción ---------------------------------------------------------
  const localX = (e: { clientX: number }) => e.clientX - (mainRef.current?.getBoundingClientRect().left ?? 0)

  const edgeAt = (x: number): Edge | null => {
    let best: Edge | null = null
    let bestD = HIT_PX
    for (const e of edgesOf(asset.slices)) {
      const d = Math.abs(frameToX(e.frame) - x)
      if (d <= bestD) {
        best = e
        bestD = d
      }
    }
    return best
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const x = localX(e)
    const hit = edgeAt(x)
    if (hit) {
      if (e.altKey) {
        if (hit.edge === 'start') removeMarker(asset.id, hit.sliceId)
        return
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag({ ...hit, to: hit.frame })
      return
    }
    const frame = xToFrame(x)
    const idx = asset.slices.findIndex((s) => s.id === sliceAt(asset.slices, frame)?.id)
    const s = asset.slices[idx]
    if (s) {
      selectSlice(s.id, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace')
      previewSlice(asset.id, s, idx, true)
    } else {
      previewFrom(asset.id, Math.round(frame))
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const x = localX(e)
    if (drag) {
      setDrag({ ...drag, to: Math.round(Math.min(asset.frames, Math.max(0, xToFrame(x)))) })
      return
    }
    setHover(edgeAt(x))
  }

  const onPointerUp = () => {
    if (!drag) return
    if (Math.abs(drag.to - drag.frame) >= 1) {
      moveSliceEdge(asset.id, drag.sliceId, drag.edge, drag.to, 'Mover marcador')
    }
    setDrag(null)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (edgeAt(localX(e))) return
    addMarkerAt(asset.id, xToFrame(localX(e)))
  }

  // La rueda necesita listener no pasivo para poder evitar el scroll de la página.
  useEffect(() => {
    const c = mainRef.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = c.getBoundingClientRect()
      const x = e.clientX - rect.left
      setView((v) => {
        const sp = v.end - v.start
        const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)
        if (horizontal) {
          const d = ((e.shiftKey ? e.deltaY : e.deltaX) / width) * sp
          const start = Math.min(asset.frames - sp, Math.max(0, v.start + d))
          return { start, end: start + sp }
        }
        const factor = Math.exp(e.deltaY * 0.002)
        const newSpan = Math.min(asset.frames, Math.max(MIN_SLICE_FRAMES * 4, sp * factor))
        const anchor = v.start + (x / width) * sp
        const start = Math.min(asset.frames - newSpan, Math.max(0, anchor - (x / width) * newSpan))
        return { start, end: start + newSpan }
      })
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [width, asset.frames])

  const onOverview = (e: React.PointerEvent) => {
    if (e.type === 'pointermove' && e.buttons !== 1) return
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const center = ((e.clientX - rect.left) / width) * asset.frames
    setView((v) => {
      const sp = v.end - v.start
      const start = Math.min(asset.frames - sp, Math.max(0, center - sp / 2))
      return { start, end: start + sp }
    })
  }

  return (
    <div className="waveform" ref={wrapRef}>
      <canvas
        ref={mainRef}
        className="wave-main"
        style={{ cursor: drag || hover ? 'ew-resize' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
      />
      <canvas ref={overRef} className="wave-overview" onPointerDown={onOverview} onPointerMove={onOverview} />
      <div className="wave-hint">
        Doble clic: marcador · Arrastrar marcador: mover · Alt+clic: quitar · Rueda: zoom · Shift+rueda: moverse
      </div>
    </div>
  )
}
