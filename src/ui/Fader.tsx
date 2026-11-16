import { useState } from 'react'

interface Props {
  value: number
  min: number
  max: number
  step: number
  title: string
  onCommit: (v: number) => void
  /** Mientras se arrastra (sin registrar paso de deshacer). */
  onPreview?: (v: number) => void
}

/** Slider que confirma al soltar: un arrastre = un paso de deshacer. */
export function Fader({ value, min, max, step, title, onCommit }: Props) {
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
      onDoubleClick={() => onCommit(0)}
    />
  )
}
