import { describe, expect, it } from 'vitest'
import { safeFileName } from './projectFile'

describe('safeFileName', () => {
  it('quita acentos y caracteres reservados', () => {
    expect(safeFileName('Sin título')).toBe('Sin titulo')
    expect(safeFileName('Canción: ñandú / v2?')).toBe('Cancion_ nandu _ v2_')
    expect(safeFileName('   ')).toBe('proyecto')
  })
})
