import { describe, expect, it } from 'vitest'
import { isBlackKey, noteName } from './notes'

describe('notes', () => {
  it('nombres', () => {
    expect(noteName(60)).toBe('C4')
    expect(noteName(36)).toBe('C2')
    expect(noteName(61)).toBe('C#4')
    expect(noteName(0)).toBe('C-1')
    expect(noteName(127)).toBe('G9')
  })
  it('teclas negras', () => {
    expect([60, 61, 62, 63, 64, 65, 66].map(isBlackKey)).toEqual([false, true, false, true, false, false, true])
  })
})
