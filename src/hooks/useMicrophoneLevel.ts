import { useEffect, useState } from "react";

export type MicrophoneMonitorState = "idle" | "starting" | "active" | "unavailable";

const MIN_LEVEL_DB = -60;

export function useMicrophoneLevel(enabled: boolean) {
  const [levelDb, setLevelDb] = useState(MIN_LEVEL_DB);
  const [state, setState] = useState<MicrophoneMonitorState>("idle");

  useEffect(() => {
    if (!enabled) {
      setLevelDb(MIN_LEVEL_DB);
      setState("idle");
      return;
    }

    let disposed = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let animation: number | null = null;
    let smoothedDb = MIN_LEVEL_DB;
    let lastPublishedAt = 0;
    setState("starting");

    void navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }).then((nextStream) => {
      if (disposed) {
        nextStream.getTracks().forEach((track) => track.stop());
        return;
      }

      stream = nextStream;
      context = new AudioContext();
      const source = context.createMediaStreamSource(nextStream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      setState("active");

      const tick = (now: number) => {
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const rms = Math.sqrt(energy / samples.length);
        const measuredDb = Math.max(MIN_LEVEL_DB, Math.min(0, 20 * Math.log10(Math.max(rms, 0.001))));
        const smoothing = measuredDb > smoothedDb ? 0.45 : 0.14;
        smoothedDb += (measuredDb - smoothedDb) * smoothing;
        if (now - lastPublishedAt >= 50) {
          setLevelDb(smoothedDb);
          lastPublishedAt = now;
        }
        animation = requestAnimationFrame(tick);
      };
      animation = requestAnimationFrame(tick);
    }).catch(() => {
      if (!disposed) {
        setLevelDb(MIN_LEVEL_DB);
        setState("unavailable");
      }
    });

    return () => {
      disposed = true;
      if (animation !== null) cancelAnimationFrame(animation);
      stream?.getTracks().forEach((track) => track.stop());
      if (context) void context.close();
    };
  }, [enabled]);

  return { levelDb, state };
}
