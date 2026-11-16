/**
 * Estado del preview que suena (para dibujar el cursor y encender pads).
 */
import { create } from 'zustand'
import { getAudioContext } from '../audio/context'
import { getLoadedAudio } from '../audio/library'
import { playRange, stopPreview, type PreviewHandle } from '../audio/preview'
import { DEFAULT_PLAYBACK, type AssetId, type Slice } from '../model'

interface PreviewState {
  handle: PreviewHandle | null
  assetId: AssetId | null
  /** Pad encendido (índice de slice) mientras dura el destello. */
  lit: number | null
}

export const usePreview = create<PreviewState>()(() => ({ handle: null, assetId: null, lit: null }))

const LIT_MS = 140
let litTimer: ReturnType<typeof setTimeout> | undefined

function lightPad(index: number): void {
  clearTimeout(litTimer)
  usePreview.setState({ lit: index })
  litTimer = setTimeout(() => usePreview.setState({ lit: null }), LIT_MS)
}

export function previewSlice(assetId: AssetId, slice: Slice, index: number, exclusive: boolean): void {
  const audio = getLoadedAudio(assetId)
  if (!audio) return
  const handle = playRange(audio.buffer, slice.start, slice.end, slice.playback, { exclusive })
  usePreview.setState({ handle, assetId })
  lightPad(index)
}

export function previewFrom(assetId: AssetId, startFrame: number, endFrame?: number): void {
  const audio = getLoadedAudio(assetId)
  if (!audio) return
  const handle = playRange(audio.buffer, startFrame, endFrame ?? audio.buffer.length, DEFAULT_PLAYBACK)
  usePreview.setState({ handle, assetId })
}

export function stopAll(): void {
  stopPreview()
  usePreview.setState({ handle: null })
}

/** Frame que está sonando del preview actual, o null si ya terminó. */
export function previewPosition(handle: PreviewHandle): number | null {
  const t = Math.max(0, getAudioContext().currentTime - handle.startedAt)
  if (t > handle.duration) return null
  const progress = t / handle.duration
  const span = handle.endFrame - handle.startFrame
  return handle.reverse ? handle.endFrame - progress * span : handle.startFrame + progress * span
}

export function isPreviewPlaying(): boolean {
  const h = usePreview.getState().handle
  return h !== null && previewPosition(h) !== null
}
