// The microphone side of voice search: recording 16 kHz mono, telling speech
// from the room's background, and the listening animation. Nothing touches
// the page on import, so the speech logic runs under Node for tests.

// The microphone streams 16 kHz mono into a buffer. While someone talks, what
// they've said so far is embedded again as soon as the previous embedding
// returns, so results refine as they speak. A pause ends the search.
const RATE = 16000;
const MAX_SAMPLES = 30 * RATE;
const PRE_ROLL = 0.3 * RATE;
// Wait for enough speech to mean something, then update after each further
// stretch rather than every chunk, so results don't churn.
const MIN_SPEECH = 1.5 * RATE;
const UPDATE_EVERY = 0.75 * RATE;
// Speech is louder than both this and NOISE_RATIO times the background level.
// Listening ends after PAUSE_MS of quiet, once they've talked for MIN_TALK_MS,
// so a breath between phrases doesn't cut them off.
const VOICE_RMS = 0.004;
const NOISE_RATIO = 3;
const PAUSE_MS = 2500;
const MIN_TALK_MS = 2000;

const CAPTURE = `registerProcessor("capture", class extends AudioWorkletProcessor {
  process([input]) {
    if (input[0]) this.port.postMessage(input[0].slice());
    return true;
  }
});`;

// Voice needs a secure page, a microphone API and audio worklets.
export const canListen = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.AudioWorkletNode);

// Some browsers only record at the device's rate (Firefox won't connect a
// microphone to a 16 kHz context), so average each stretch of input samples
// down to one 16 kHz sample.
export function downsampler(from) {
  const step = from / RATE;
  let sum = 0;
  let count = 0;
  let due = step;
  return (chunk) => {
    const out = new Float32Array(Math.ceil(chunk.length / step) + 1);
    let n = 0;
    for (const sample of chunk) {
      sum += sample;
      count++;
      if (count >= due) {
        out[n++] = sum / count;
        due += step - count;
        sum = 0;
        count = 0;
      }
    }
    return out.subarray(0, n);
  };
}

// --- Recording -------------------------------------------------------------

export function microphone() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
}

// An audio worklet that posts the microphone's samples, and `resample` to
// bring them to 16 kHz. If it can't start, the stream is stopped first.
export async function capture(stream) {
  let context;
  try {
    context = new AudioContext();
    await context.resume();
    const url = URL.createObjectURL(new Blob([CAPTURE], { type: "text/javascript" }));
    await context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(context, "capture");
    context.createMediaStreamSource(stream).connect(node);
    return { context, node, resample: downsampler(context.sampleRate) };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    context?.close();
    throw error;
  }
}

// Add 16 kHz samples to the session and track whether they're talking.
// True once they've finished: a long enough pause after enough talk.
export function addChunk(session, data) {
  let energy = 0;
  for (const sample of data) energy += sample * sample;
  const now = performance.now();
  // Smooth the level over a few tens of milliseconds, and track the room's
  // background level so speech is whatever stands well clear of it.
  const rms = Math.sqrt(energy / data.length);
  session.level = session.level === undefined ? rms : session.level * 0.8 + rms * 0.2;
  session.floor ??= session.level;
  if (session.level > Math.max(VOICE_RMS, session.floor * NOISE_RATIO)) {
    if (!session.speaking) session.spokeAt = now;
    session.speaking = true;
    session.heardAt = now;
  } else {
    // Only between words, so talking doesn't raise it. It falls straight
    // to a quieter room and rises slowly with a louder one.
    session.floor = Math.min(session.floor * 1.001, session.level);
  }
  session.chunks.push(data);
  session.length += data.length;
  session.received += data.length;
  // Keep a moment of lead-in before speech, and at most MAX_SAMPLES after.
  const keep = session.speaking ? MAX_SAMPLES : PRE_ROLL;
  while (session.length - session.chunks[0].length > keep) {
    session.length -= session.chunks.shift().length;
  }
  const paused = now - session.heardAt > PAUSE_MS;
  return Boolean(session.speaking && paused && now - session.spokeAt > MIN_TALK_MS);
}

// Whether there's new speech worth searching: enough of it, and either
// listening has stopped or a further UPDATE_EVERY of it has come in.
export function due(session) {
  if (session.busy || !session.speaking) return false;
  if (session.length < MIN_SPEECH || session.received === session.embedded) return false;
  return session.stopped || session.received - session.embedded >= UPDATE_EVERY;
}

// Everything the session holds, as one buffer.
export function joined(session) {
  const audio = new Float32Array(session.length);
  let offset = 0;
  for (const chunk of session.chunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }
  return audio;
}

// --- Listening animation ----------------------------------------------------

// A row of rounded bars in the search box, driven by the microphone level:
// tallest in the middle, each wobbling at its own pace so it reads as a
// voice. When listening stops, the bars settle into dots that ripple until
// the last results arrive, then fade away.
const BARS = 28;
let waveFrame;

// Microphone level (RMS) to 0–1 on a decibel scale: quiet rooms sit near 0,
// ordinary speech around 0.6–0.9.
function loudness(level = 0) {
  const db = 20 * Math.log10(level + 1e-6);
  return Math.min(1, Math.max(0, (db + 55) / 40));
}

function bars() {
  return {
    heights: new Float32Array(BARS),
    phases: Array.from({ length: BARS }, (_, i) => i * 2.399),
    speeds: Array.from({ length: BARS }, (_, i) => 5 + ((i * 7) % 5)),
    envelope: Array.from({ length: BARS }, (_, i) => {
      const x = (i - (BARS - 1) / 2) / (BARS * 0.3);
      return 0.18 + 0.82 * Math.exp(-x * x);
    }),
  };
}

// Listening has stopped, but the last results haven't arrived yet.
function finishing(session, { voice, ready }) {
  return (
    session === voice &&
    session.stopped &&
    session.speaking &&
    (session.busy || session.transcribing || session.received !== session.embedded || !ready)
  );
}

// How tall bar `i` wants to be: a soft ripple along the dots while the final
// results come in, otherwise the voice's level shaped by the envelope.
function barTarget(shape, i, frame) {
  if (frame.finishing && !frame.calm) return 0.12 + 0.12 * Math.max(0, Math.sin(frame.t * 7 - i * 0.45));
  const wobble = frame.calm ? 1 : 0.55 + 0.45 * Math.sin(frame.t * shape.speeds[i] + shape.phases[i]);
  return frame.level * shape.envelope[i] * wobble;
}

// Size the canvas to the box at the screen's pixel ratio, and clear it.
function fit(wave, context) {
  const { width, height } = wave.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  if (wave.width !== Math.round(width * ratio)) {
    wave.width = Math.round(width * ratio);
    wave.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { width, height };
}

function drawBars(context, shape, frame) {
  const step = frame.width / BARS;
  const bar = Math.min(3, step * 0.55);
  for (let i = 0; i < BARS; i++) {
    const target = barTarget(shape, i, frame);
    const current = shape.heights[i];
    // Rise quickly, fall back gently.
    const height = current + (target - current) * (target > current ? 0.45 : 0.12);
    shape.heights[i] = height;
    const h = Math.max(bar, height * (frame.height - 6));
    context.globalAlpha = 0.45 + 0.55 * shape.envelope[i];
    context.beginPath();
    context.roundRect(i * step + (step - bar) / 2, (frame.height - h) / 2, bar, h, bar / 2);
    context.fill();
  }
}

// `current()` gives the latest voice session and whether the model is ready.
export function showWave(session, current) {
  const wave = document.querySelector(".site-search .site-search-wave");
  const box = wave.parentElement;
  const context = wave.getContext("2d");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  const shape = bars();
  const color = getComputedStyle(wave).getPropertyValue("--accent").trim() || "#4f46e5";
  let fading = false;

  cancelAnimationFrame(waveFrame);
  wave.hidden = false;
  requestAnimationFrame(() => box.classList.add("is-listening"));

  const draw = (now) => {
    const size = fit(wave, context);
    const still = finishing(session, current());
    const level = session.stopped ? 0 : loudness(session.level);
    context.fillStyle = color;
    drawBars(context, shape, { ...size, t: now / 1000, level, finishing: still, calm: calm.matches });

    if (session.stopped && !still && !fading) {
      fading = true;
      box.classList.remove("is-listening");
      setTimeout(() => {
        // Unless a new voice search has started and taken over the canvas.
        const { voice } = current();
        if (!voice || voice === session || voice.stopped) {
          cancelAnimationFrame(waveFrame);
          wave.hidden = true;
        }
      }, 300);
    }
    if (!wave.hidden) waveFrame = requestAnimationFrame(draw);
  };
  waveFrame = requestAnimationFrame(draw);
}
