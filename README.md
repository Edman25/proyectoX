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
- `src/audio/` — AudioContext, importación/decodificación, preview de slices y el host del motor (motor + sesión en vivo + router de entradas).
- `src/engine/` — motor de audio, grabador, cuantizar y note repeat. Ver [`docs/ENGINE.md`](docs/ENGINE.md).
- `src/midi/` — router de entradas, learn y Web MIDI.
- `src/ui/` — biblioteca, editor de onda, inspector de slices y pads.

## Atajos

| Tecla | Acción |
|---|---|
| Z X C V / A S D F / Q W E R / 1 2 3 4 | Pads 1–16 de la pista seleccionada (o slices del sample); misma forma que la grilla, pad 1 abajo a la izquierda |
| Espacio | Play / stop del transporte |
| Shift+Espacio | Grabar (count-in; si no hay pistas armadas, arma la seleccionada) |
| Enter | Escuchar el sample completo / parar |
| ← → (Shift para extender) | Moverse entre slices |
| M | Unir slices seleccionados |
| Supr / Retroceso | Quitar el marcador al inicio del slice |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Deshacer / rehacer |
| Doble clic en la onda | Marcador nuevo |
| Alt+clic en un marcador | Quitarlo |
| Rueda / Shift+rueda | Zoom / desplazarse |

## Controlador MIDI

1. Conecta el controlador por USB y abre la app en Chrome o Edge.
2. Clic en **Conectar MIDI** (arriba a la derecha). El navegador pide permiso.
3. En el panel: **Aprender pads** y toca tus pads en orden (el primero será el pad 1). Luego **Aprender** el botón de grabar (y play/stop/note repeat si quieres).
4. Los pads tocan la pista seleccionada. En "En este proyecto" puedes mandar cada pad a otro sonido u otra pista.
5. Si lo grabado queda tarde, ajusta la **latencia de grabación**.

Sin aprender nada, el controlador funciona como teclado: la nota MIDI 36 es el pad 1, 37 el pad 2, etc.

En desarrollo hay un controlador simulado en la consola: `const c = __px.fakeController('Prueba'); c.down(36); c.up(36)`.
