/**
 * main-av.js — AVVA Program 2 standalone entry point.
 *
 * AUDIO → VIS only. Listens to a mic input (or, in loop.html, a tapped
 * AudioNode), runs AudioAnalyzer, paints AudioRenderer. Does NOT host
 * Program 1's video analysis or synth.
 *
 * For the closed-loop dev harness, use loop.js which orchestrates both.
 */

import { CONFIG } from "./modules/config.js";
import { Key } from "./modules/music.js";
import { AudioAnalyzer } from "./modules/audio-analyzer.js";
import { AudioRenderer } from "./modules/audio-renderer.js";

let actx, analyzer, renderer, key;

async function begin() {
  const canvas = document.getElementById("av-canvas");
  if (!canvas) throw new Error("av-canvas not found");

  key = new Key({
    root: CONFIG.root,
    mode: CONFIG.mode,
    octave: CONFIG.octave,
  });

  actx = new AudioContext();
  analyzer = new AudioAnalyzer({ audioContext: actx, key });
  renderer = new AudioRenderer(canvas, key.chromaticHues);
  window.addEventListener("resize", () => renderer.resize());

  // Standalone mode: ask for mic
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const src = actx.createMediaStreamSource(stream);
  analyzer.connect(src);

  document.getElementById("gate")?.classList.add("hide");
  requestAnimationFrame(loop);
}

function loop() {
  const frame = analyzer.tick();
  renderer.render(frame);
  requestAnimationFrame(loop);
}

document.getElementById("go")?.addEventListener("click", () => {
  begin().catch((e) => {
    const err = document.getElementById("err");
    if (err) err.textContent = "Audio error: " + (e.message || e.name);
  });
});
