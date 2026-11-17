import { useState } from 'react'

interface Props {
  value: number
  min: number
  max: number
  step: number
  title: string
  onCommit: (v: number) => void
  /** Valor al que vuelve con doble clic (por defecto 0). */
  neutral?: number
}

/** Slider que confirma al soltar: un arrastre = un paso de deshacer. */
export function Fader({ value, min, max, step, title, onCommit, neutral = 0 }: Props) {
  const [dragValue, setDragValue] = useState<number | null>(null)
  const shown = dragValue ?? value
  const finish = () => {
    if (dragValue !== null && dragValue !== value) onCommit(dragValue)
    setDragValue(null)
  }
  return (
    <input
      type="range"
      className="fader"
      min={min}
      max={max}
      step={step}
      value={shown}
      title={`${title}: ${shown}`}
      onChange={(e) => setDragValue(Number(e.target.value))}
      onPointerUp={finish}
      onKeyUp={finish}
      onBlur={finish}
      onDoubleClick={() => onCommit(neutral)}
    />
  )
}
