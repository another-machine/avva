# avva v2 — Consolidation Plan

## Decisions

- **Tooling:** Vite + TypeScript
- **Controller transport:** BroadcastChannel + WebSocket relay (both, same phase)
- **Loop mode:** kept but behind a flag (not main UI)
- **Persistence:** localStorage + shareable URL hash

## Target tree

```
src/
  store/        schema, store, sync (BroadcastChannel + WS)
  input/        source (camera | file | screen | url), playback
  analysis/     video-analyzer, audio-analyzer, smoothing
  harmony/      harmony-source interface, scale, palette, hue-perception, chord-parser
  audio/        synth, fm-voice
  render/       video-renderer, audio-renderer-gl, motion-overlay
  controls/     keyboard, calibration-panel
  views/        analysis-view, loop-view
  main.ts
controller/
  controller.html, controller.ts
server/
  relay.ts      (Node WS relay for phone/LAN control)
index.html
vite.config.ts
tsconfig.json
```

## Phases

1. **Scaffold** — Vite + TS, port modules, schema + store, localStorage + URL hash. App works identically to today.
2. **Consolidate** — single index.html, view switcher, kill main-av.js + va.html + loop.html, unify Key/Palette behind HarmonySource, extract shared EMA.
3. **Controller** — controller.html, BroadcastChannel transport, WS relay stub, auto-generated UI from schema metadata.
4. **Input expansion** — screen capture, file playbackRate + scrub, source picker UI.
5. **Phone** — LAN URL + QR code, touch-friendly controller layout.
6. **Polish** — keyboard consolidation, motion overlay extraction, dead code pruning.

## Key design notes

- **Store:** observable, typed, layered init (defaults ← localStorage ← URL hash). Patches go through one path: `set(path, value) → notify subscribers → broadcast`. Origin tag on patches prevents echo loops across transports.
- **Calibration:** stops being a side-channel; becomes a slice of the store.
- **VideoSource:** strategy union `camera | file | screen | url`. Screen uses `getDisplayMedia()`.
- **HarmonySource:** Key and Palette conform to one interface; swap at runtime via store.
- **Schema-driven controller UI:** each setting has `{ default, range, step, label, group }` metadata; the controller renders sliders/toggles automatically.
