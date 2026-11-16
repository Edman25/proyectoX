import { describe, expect, it } from 'vitest'
import {
  MIN_SLICE_FRAMES,
  addMarker,
  deleteSlice,
  equalDivisionBoundaries,
  gridBoundaries,
  mergeSlices,
  moveEdge,
  removeMarkerBefore,
  slicesFromBoundaries,
  splitSlice,
} from './sliceOps'
import type { Slice } from './project'

const ranges = (s: Slice[]) => s.map((x) => [x.start, x.end])

describe('sliceOps', () => {
  it('slices desde cortes cubren todo el audio', () => {
    const s = slicesFromBoundaries(1000, [500, 250, 250, 0, 1000, 750])
    expect(ranges(s)).toEqual([
      [0, 250],
      [250, 500],
      [500, 750],
      [750, 1000],
    ])
  })

  it('no deja slices diminutos', () => {
    const s = slicesFromBoundaries(1000, [500, 510])
    expect(ranges(s)).toEqual([
      [0, 510],
      [510, 1000],
    ])
    expect(s.every((x) => x.end - x.start >= MIN_SLICE_FRAMES)).toBe(true)
  })

  it('divisiones iguales y rejilla', () => {
    expect(equalDivisionBoundaries(1000, 4)).toEqual([250, 500, 750])
    // 120 BPM, 1 tiempo = 0.5 s = 22050 frames a 44.1k
    expect(gridBoundaries(88200, 44100, 120, 1)).toEqual([22050, 44100, 66150])
    expect(gridBoundaries(88200, 44100, 120, 1, 100)).toEqual([100, 22150, 44200, 66250])
  })

  it('partir conserva el id del primero y copia ajustes', () => {
    const [a] = slicesFromBoundaries(1000, [])
    a!.playback.gainDb = -3
    const s = splitSlice([a!], a!.id, 400)
    expect(ranges(s)).toEqual([
      [0, 400],
      [400, 1000],
    ])
    expect(s[0]!.id).toBe(a!.id)
    expect(s[1]!.id).not.toBe(a!.id)
    expect(s[1]!.playback.gainDb).toBe(-3)
  })

  it('agregar marcador sin slices crea dos', () => {
    expect(ranges(addMarker([], 1000, 300))).toEqual([
      [0, 300],
      [300, 1000],
    ])
  })

  it('unir solo slices consecutivos', () => {
    const s = slicesFromBoundaries(1000, [250, 500, 750])
    const merged = mergeSlices(s, [s[2]!.id, s[1]!.id])
    expect(ranges(merged!)).toEqual([
      [0, 250],
      [250, 750],
      [750, 1000],
    ])
    expect(merged![1]!.id).toBe(s[1]!.id)
    expect(mergeSlices(s, [s[0]!.id, s[2]!.id])).toBeNull()
  })

  it('quitar marcador une con el anterior', () => {
    const s = slicesFromBoundaries(1000, [500])
    expect(ranges(removeMarkerBefore(s, s[1]!.id))).toEqual([[0, 1000]])
    expect(ranges(removeMarkerBefore(s, s[0]!.id))).toEqual(ranges(s))
  })

  it('mover un borde compartido mueve al vecino y respeta límites', () => {
    const s = slicesFromBoundaries(1000, [500])
    expect(ranges(moveEdge(s, 1000, s[1]!.id, 'start', 600))).toEqual([
      [0, 600],
      [600, 1000],
    ])
    const clamped = moveEdge(s, 1000, s[0]!.id, 'end', 990)
    expect(clamped[0]!.end).toBe(1000 - MIN_SLICE_FRAMES)
    expect(clamped[1]!.start).toBe(1000 - MIN_SLICE_FRAMES)
  })

  it('mover un borde con hueco no invade al vecino', () => {
    const full = slicesFromBoundaries(1000, [300, 600])
    const s = deleteSlice(full, full[1]!.id)
    // sin el slice del medio quedan [0,300] y [600,1000] con hueco
    expect(ranges(s)).toEqual([
      [0, 300],
      [600, 1000],
    ])
    const moved = moveEdge(s, 1000, s[0]!.id, 'end', 800)
    expect(moved[0]!.end).toBe(600)
    expect(moved[1]!.start).toBe(600)
  })
})
