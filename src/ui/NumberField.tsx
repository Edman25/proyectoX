import { useState } from 'react'

interface Props {
  label: string
  value: number
  onCommit: (v: number) => void
  min?: number
  max?: number
  step?: number
  unit?: string
  width?: number
}

/**
 * Campo numérico que confirma al salir, con Enter o con las flechas: así un
 * cambio es un solo paso de deshacer y no uno por tecla.
 */
export function NumberField({ label, value, onCommit, min, max, step = 1, unit, width = 64 }: Props) {
  const [text, setText] = useState(String(value))
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    // El valor cambió desde fuera (deshacer, otro slice): mostrar el nuevo.
    setShown(value)
    setText(String(value))
  }

  const commit = (raw: string) => {
    const n = Number(raw)
    if (!Number.isFinite(n) || raw.trim() === '') return setText(String(value))
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
    setText(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        style={{ width }}
        onChange={(e) => {
          setText(e.target.value)
          // Flechas del input y rueda: confirmar al momento.
          const native = e.nativeEvent as Partial<InputEvent>
          if (!native.inputType || native.inputType === 'insertReplacementText') commit(e.target.value)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value)
          if (e.key === 'Escape') setText(String(value))
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </label>
  )
}
