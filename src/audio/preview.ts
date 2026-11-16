/**
 * Preview de slices para la fase 1: toca una porción de un buffer con
 * micro-fades. Es provisional: cuando el motor esté integrado, los pads
 * tocarán a través de él (misma ruta que el secuenciador y el MIDI).
 */
import { EDGE_FADE_MS, type PlaybackOptions } from '../model'
import { getAudioContext, resumeAudio } from './context'

const reversedCache = new WeakMap<AudioBuffer, AudioBuffer>()

function reversed(buffer: AudioBuffer): AudioBuffer {
  let r = reversedCache.get(buffer)
  if (!r) {
    r = getAudioContext().createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c).slice().reverse()
      r.copyToChannel(data, c)
    }
    reversedCache.set(buffer, r)
  }
  return r
}

export interface PreviewHandle {
  stop(): void
  /** Tiempo del AudioContext en que empezó y duración en segundos (para el cursor). */
  startedAt: number
  duration: number
  startFrame: number
  endFrame: number
  reverse: boolean
}

let current: { source: AudioBufferSourceNode; gain: GainNode } | null = null

export function stopPreview(): void {
  if (!current) return
  const ctx = getAudioContext()
  const { source, gain } = current
  gain.gain.cancelScheduledValues(ctx.currentTime)
  gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005)
  source.stop(ctx.currentTime + 0.05)
  current = null
}

export function playRange(
  buffer: AudioBuffer,
  startFrame: number,
  endFrame: number,
  playback: PlaybackOptions,
  opts: { exclusive?: boolean } = {},
): PreviewHandle {
  resumeAudio()
  const ctx = getAudioContext()
  if (opts.exclusive ?? true) stopPreview()

  const sr = buffer.sampleRate
  const src = ctx.createBufferSource()
  const rate = Math.pow(2, playback.pitch / 12)
  src.buffer = playback.reverse ? reversed(buffer) : buffer
  src.playbackRate.value = rate

  const offset = (playback.reverse ? buffer.length - endFrame : startFrame) / sr
  const length = (endFrame - startFrame) / sr
  const duration = length / rate

  const gain = ctx.createGain()
  const level = Math.pow(10, playback.gainDb / 20)
  const fadeIn = Math.max(EDGE_FADE_MS, playback.fadeInMs) / 1000
  const fadeOut = Math.max(EDGE_FADE_MS, playback.fadeOutMs) / 1000
  const t0 = ctx.currentTime + 0.005
  const g = gain.gain
  g.setValueAtTime(0, t0)
  g.linearRampToValueAtTime(level, t0 + Math.min(fadeIn, duration / 2))
  g.setValueAtTime(level, t0 + Math.max(duration - fadeOut, duration / 2))
  g.linearRampToValueAtTime(0, t0 + duration)

  src.connect(gain).connect(ctx.destination)
  src.start(t0, offset, length)
  const handle = { source: src, gain }
  current = handle
  src.onended = () => {
    if (current === handle) current = null
  }

  return {
    stop: () => {
      if (current === handle) stopPreview()
    },
    startedAt: t0,
    duration,
    startFrame,
    endFrame,
    reverse: playback.reverse,
  }
}
