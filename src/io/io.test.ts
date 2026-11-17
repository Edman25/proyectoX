import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWav } from './wav'
import { crc32, readZip, writeZip } from './zip'

describe('wav', () => {
  const audio = {
    sampleRate: 44100,
    channels: [new Float32Array([0, 0.5, -0.5, 1, -1]), new Float32Array([0.25, -0.25, 0, 0.75, -0.75])],
  }
  for (const format of [16, 24, 32] as const) {
    it(`ida y vuelta a ${format} bits`, () => {
      const back = decodeWav(encodeWav(audio, format))
      expect(back.sampleRate).toBe(44100)
      expect(back.channels).toHaveLength(2)
      const tol = format === 16 ? 1e-4 : 1e-6
      back.channels.forEach((ch, c) => ch.forEach((x, i) => expect(Math.abs(x - audio.channels[c]![i]!)).toBeLessThan(tol)))
    })
  }
  it('satura en lugar de dar la vuelta', () => {
    const back = decodeWav(encodeWav({ sampleRate: 8000, channels: [new Float32Array([1.7, -3])] }, 16))
    expect(back.channels[0]![0]).toBeCloseTo(1, 3)
    expect(back.channels[0]![1]).toBeCloseTo(-1, 3)
  })
})

describe('zip', () => {
  it('crc32 conocido', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
  it('ida y vuelta con nombres UTF-8 y binario', async () => {
    const entries = [
      { name: 'project.json', data: new TextEncoder().encode('{"name":"Canción ñ"}') },
      { name: 'audio/a.wav', data: new Uint8Array([0, 255, 1, 2, 3]) },
    ]
    const back = await readZip(writeZip(entries))
    expect(back.map((e) => e.name)).toEqual(['project.json', 'audio/a.wav'])
    expect(new TextDecoder().decode(back[0]!.data)).toBe('{"name":"Canción ñ"}')
    expect(Array.from(back[1]!.data)).toEqual([0, 255, 1, 2, 3])
  })
  it('rechaza lo que no es ZIP', async () => {
    await expect(readZip(new Uint8Array(40))).rejects.toThrow()
  })
})
