/**
 * DrumSynth — sample-free percussive voices for the drum machine.
 *
 * All voices are node-per-hit: create nodes → schedule → auto-GC when stopped.
 * Output bus connects to whatever AudioNode is passed as `output` (typically
 * graph.layerSum so drums inherit the cassette chain).
 */

// Cache a noise buffer per AudioContext so we don't reallocate on every hit.
const _noiseCache = new WeakMap<AudioContext, AudioBuffer>();

function _getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  let buf = _noiseCache.get(ctx);
  if (!buf) {
    const len = Math.floor(ctx.sampleRate * 0.5);
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    _noiseCache.set(ctx, buf);
  }
  return buf;
}

export class DrumSynth {
  private _ctx: AudioContext;
  private _bus: GainNode;
  private _filter: BiquadFilterNode;
  private _echoDelay: DelayNode;
  private _echoFb: GainNode;
  private _echoDamp: BiquadFilterNode;
  private _echoWet: GainNode;

  constructor(ctx: AudioContext, output: AudioNode) {
    this._ctx = ctx;
    this._bus = ctx.createGain();
    this._bus.gain.value = 0.7;

    // Character chain: bus → LP filter → dry out, plus a tape-style echo tap
    // (damped feedback loop, same family as the cassette slapback). Neutral by
    // default: filter wide open, echo wet at 0.
    this._filter = ctx.createBiquadFilter();
    this._filter.type = "lowpass";
    this._filter.frequency.value = 12000;
    this._filter.Q.value = 0.7;
    this._bus.connect(this._filter);
    this._filter.connect(output);

    this._echoDelay = ctx.createDelay(1.0);
    this._echoDelay.delayTime.value = 0.22;
    this._echoFb = ctx.createGain();
    this._echoFb.gain.value = 0.35;
    this._echoDamp = ctx.createBiquadFilter();
    this._echoDamp.type = "lowpass";
    this._echoDamp.frequency.value = 3500;
    this._echoWet = ctx.createGain();
    this._echoWet.gain.value = 0;
    this._filter.connect(this._echoDelay);
    this._echoDelay.connect(this._echoDamp);
    this._echoDamp.connect(this._echoFb);
    this._echoFb.connect(this._echoDelay);
    this._echoDamp.connect(this._echoWet);
    this._echoWet.connect(output);
  }

  setVolume(v: number): void {
    this._bus.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this._ctx.currentTime, 0.02);
  }

  setFilter(hz: number, q: number): void {
    const now = this._ctx.currentTime;
    this._filter.frequency.setTargetAtTime(Math.max(100, hz), now, 0.03);
    this._filter.Q.setTargetAtTime(Math.max(0.1, Math.min(12, q)), now, 0.03);
  }

  setEcho(timeMs: number, feedback: number, wet: number): void {
    const now = this._ctx.currentTime;
    this._echoDelay.delayTime.setTargetAtTime(
      Math.max(0.01, Math.min(1, timeMs / 1000)),
      now,
      0.05,
    );
    this._echoFb.gain.setTargetAtTime(Math.max(0, Math.min(0.9, feedback)), now, 0.03);
    this._echoWet.gain.setTargetAtTime(Math.max(0, Math.min(1, wet)), now, 0.03);
  }

  kick(time: number, vel = 1): void {
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    // Pitch envelope: 150 Hz → 45 Hz over 50 ms
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.05);
    // Amplitude envelope: sharp attack, 350 ms decay
    gain.gain.setValueAtTime(vel * 1.0, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.35);
    osc.connect(gain);
    gain.connect(this._bus);
    osc.start(time);
    osc.stop(time + 0.36);
  }

  snare(time: number, vel = 1): void {
    const ctx = this._ctx;
    const noise = _getNoiseBuffer(ctx);

    // Body: short sine burst at ~200 Hz
    const bodyOsc = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    bodyOsc.type = "sine";
    bodyOsc.frequency.value = 200;
    bodyGain.gain.setValueAtTime(vel * 0.6, time);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    bodyOsc.connect(bodyGain);
    bodyGain.connect(this._bus);
    bodyOsc.start(time);
    bodyOsc.stop(time + 0.09);

    // Snap: white noise band-pass filtered
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1500;
    hp.Q.value = 0.7;
    const snapGain = ctx.createGain();
    snapGain.gain.setValueAtTime(vel * 0.5, time);
    snapGain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
    src.connect(hp);
    hp.connect(snapGain);
    snapGain.connect(this._bus);
    src.start(time);
    src.stop(time + 0.13);
  }

  hihatClosed(time: number, vel = 1): void {
    const ctx = this._ctx;
    const src = ctx.createBufferSource();
    src.buffer = _getNoiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 8000;
    hp.Q.value = 0.5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vel * 0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    src.connect(hp);
    hp.connect(gain);
    gain.connect(this._bus);
    src.start(time);
    src.stop(time + 0.06);
  }

  hihatOpen(time: number, vel = 1): void {
    const ctx = this._ctx;
    const src = ctx.createBufferSource();
    src.buffer = _getNoiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 6000;
    hp.Q.value = 0.3;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vel * 0.25, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
    src.connect(hp);
    hp.connect(gain);
    gain.connect(this._bus);
    src.start(time);
    src.stop(time + 0.31);
  }

  rim(time: number, vel = 1): void {
    const ctx = this._ctx;
    const src = ctx.createBufferSource();
    src.buffer = _getNoiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1200;
    bp.Q.value = 2.5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vel * 0.45, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.025);
    src.connect(bp);
    bp.connect(gain);
    gain.connect(this._bus);
    src.start(time);
    src.stop(time + 0.03);
  }

  disconnect(): void {
    this._bus.disconnect();
    this._filter.disconnect();
    this._echoDelay.disconnect();
    this._echoDamp.disconnect();
    this._echoFb.disconnect();
    this._echoWet.disconnect();
  }
}
