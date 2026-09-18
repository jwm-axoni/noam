// Mention-style ping chime, synthesized with WebAudio so there's no asset to
// ship. Two soft sine notes (E6 → A6) with a fast decay — audible but polite.

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null; // no audio device / autoplay blocked — ping stays visual
  }
}

export function playPingSound(): void {
  const ac = audioContext();
  if (!ac) return;
  const t0 = ac.currentTime;
  for (const [freq, at] of [
    [1318.5, 0], // E6
    [1760.0, 0.12], // A6
  ] as const) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(0.18, t0 + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.4);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.45);
  }
}
