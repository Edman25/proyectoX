/** Nombres de nota. Convención: 60 = C4 (la más común en DAWs y controladores). */
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

export function noteName(pitch: number): string {
  const p = Math.round(pitch)
  return `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((Math.round(pitch) % 12) + 12) % 12)
}
