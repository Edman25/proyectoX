/**
 * WAV: codificar (export) y decodificar (abrir proyectos). PCM 16/24 bits o
 * float de 32 bits, intercalado.
 */

export type WavFormat = 16 | 24 | 32

export interface PcmAudio {
  sampleRate: number
  channels: Float32Array[]
}

export function encodeWav(audio: PcmAudio, format: WavFormat = 24): Uint8Array<ArrayBuffer> {
  const { sampleRate, channels } = audio
  const numCh = Math.max(1, channels.length)
  const frames = channels[0]?.length ?? 0
  const bytes = format / 8
  const dataSize = frames * numCh * bytes
  const out = new Uint8Array(44 + dataSize)
  const v = new DataView(out.buffer)
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, format === 32 ? 3 : 1, true) // 3 = float, 1 = PCM
  v.setUint16(22, numCh, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * numCh * bytes, true)
  v.setUint16(32, numCh * bytes, true)
  v.setUint16(34, format, true)
  ascii(36, 'data')
  v.setUint32(40, dataSize, true)
  let o = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const x = channels[c]?.[i] ?? 0
      if (format === 32) v.setFloat32(o, x, true)
      else {
        const s = Math.max(-1, Math.min(1, x))
        if (format === 16) v.setInt16(o, Math.round(s * 32767), true)
        else {
          const n = Math.round(s * 8388607)
          v.setUint8(o, n & 0xff)
          v.setUint8(o + 1, (n >> 8) & 0xff)
          v.setUint8(o + 2, (n >> 16) & 0xff)
        }
      }
      o += bytes
    }
  }
  return out
}

/** Decodifica un WAV PCM (16/24/32) o float (32). Lanza si el formato no es ese. */
export function decodeWav(data: Uint8Array): PcmAudio {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('No es un WAV')
  let o = 12
  let fmt: { audioFormat: number; numCh: number; sampleRate: number; bits: number } | null = null
  while (o + 8 <= data.byteLength) {
    const id = tag(o)
    const size = v.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ') {
      fmt = { audioFormat: v.getUint16(body, true), numCh: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV sin formato')
      const { audioFormat, numCh, sampleRate, bits } = fmt
      const bytes = bits / 8
      const frames = Math.floor(Math.min(size, data.byteLength - body) / (bytes * numCh))
      const channels = Array.from({ length: numCh }, () => new Float32Array(frames))
      let p = body
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < numCh; c++) {
          let x: number
          if (audioFormat === 3 && bits === 32) x = v.getFloat32(p, true)
          else if (bits === 16) x = v.getInt16(p, true) / 32768
          else if (bits === 24) x = ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) / 8388608)
          else if (bits === 32) x = v.getInt32(p, true) / 2147483648
          else throw new Error(`WAV de ${bits} bits no soportado`)
          channels[c]![i] = x
          p += bytes
        }
      }
      return { sampleRate, channels }
    }
    o = body + size + (size % 2)
  }
  throw new Error('WAV sin datos')
}
