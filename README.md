# proyectoX

Sampler de chops para tocar y grabar: cargar → cortar → mapear → tocar → grabar → arreglar.

El plan, la filosofía y las fases están en [`docs/PLAN.md`](docs/PLAN.md).

## Correr en local

Requiere Node 22+ y Chrome o Edge (para Web MIDI).

```sh
npm install
npm run dev      # abre http://localhost:5173
npm run check    # typecheck + lint + tests
```

## Estructura

- `src/model/` — tipos del proyecto (JSON puro), tiempo en ticks, eventos y operaciones puras sobre slices. Es el contrato entre todo lo demás.
- `src/analysis/` — picos de la forma de onda, detección de golpes, cruces por cero.
- `src/state/` — estado de la app (Zustand), deshacer/rehacer con parches de Immer, acciones y autoguardado.
- `src/storage/` — IndexedDB: el audio y el proyecto se quedan en tu navegador.
- `src/audio/` — AudioContext, importación/decodificación y preview provisional de slices.
- `src/ui/` — biblioteca, editor de onda, inspector de slices y pads.

## Atajos

| Tecla | Acción |
|---|---|
| Z X C V / A S D F / Q W E R / 1 2 3 4 | Pads 1–16 (misma forma que la grilla, pad 1 abajo a la izquierda) |
| Espacio | Escuchar el sample completo / parar |
| ← → (Shift para extender) | Moverse entre slices |
| M | Unir slices seleccionados |
| Supr / Retroceso | Quitar el marcador al inicio del slice |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Deshacer / rehacer |
| Doble clic en la onda | Marcador nuevo |
| Alt+clic en un marcador | Quitarlo |
| Rueda / Shift+rueda | Zoom / desplazarse |
