const SPEAKING_RMS = 0.018;
const UI_IDLE_MS = 500;
const SILENCE_COMMIT_MS = 2000;

export function watchMicActivity(
  stream: MediaStream,
  opts: {
    onSpeaking: (speaking: boolean) => void;
    onSilenceCommit?: () => void;
  },
): () => void {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);

  let speaking = false;
  let quietSince = performance.now();
  let committed = false;
  let idleTimer: number | null = null;
  let raf = 0;

  const tick = () => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();
    const loud = rms >= SPEAKING_RMS;

    if (loud) {
      quietSince = now;
      committed = false;
      if (idleTimer) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (!speaking) {
        speaking = true;
        opts.onSpeaking(true);
      }
    } else if (speaking) {
      if (!idleTimer) {
        idleTimer = window.setTimeout(() => {
          speaking = false;
          opts.onSpeaking(false);
          idleTimer = null;
        }, UI_IDLE_MS);
      }
      if (!committed && now - quietSince >= SILENCE_COMMIT_MS) {
        committed = true;
        opts.onSilenceCommit?.();
      }
    } else if (!committed && now - quietSince >= SILENCE_COMMIT_MS) {
      committed = true;
      opts.onSilenceCommit?.();
    }

    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    if (idleTimer) window.clearTimeout(idleTimer);
    void ctx.close();
  };
}
