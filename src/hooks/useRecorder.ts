import { useCallback, useEffect, useRef, useState } from "react";

interface Recording {
  bytes: Uint8Array;
  mimeType: string;
  durationMs: number;
}

export interface StopOptions {
  trimSilence: boolean;
  thresholdDb: number;
}

const writeText = (view: DataView, offset: number, text: string) => {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
};

const encodeWav = (samples: Float32Array, sampleRate: number) => {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeText(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(view, 8, "WAVE");
  writeText(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
};

const resample = (samples: Float32Array, sourceRate: number, targetRate = 16000) => {
  if (sourceRate === targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
};

async function trimToSpeech(blob: Blob, thresholdDb: number): Promise<Recording | null> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
      const data = audio.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) mono[index] += data[index] / audio.numberOfChannels;
    }
    const frameSize = Math.max(1, Math.round(audio.sampleRate * 0.02));
    const threshold = 10 ** (thresholdDb / 20);
    const active: boolean[] = [];
    for (let offset = 0; offset < mono.length; offset += frameSize) {
      let energy = 0;
      const end = Math.min(mono.length, offset + frameSize);
      for (let index = offset; index < end; index += 1) energy += mono[index] * mono[index];
      active.push(Math.sqrt(energy / Math.max(1, end - offset)) >= threshold);
    }
    const firstActive = active.indexOf(true);
    const lastActive = active.lastIndexOf(true);
    if (firstActive < 0) return null;

    const paddingFrames = Math.ceil(0.12 / 0.02);
    const minGapFrames = Math.ceil(0.65 / 0.02);
    const firstFrame = Math.max(0, firstActive - paddingFrames);
    const lastFrame = Math.min(active.length, lastActive + paddingFrames + 1);
    const ranges: Array<[number, number]> = [];
    let rangeStart = firstFrame;
    let frame = firstFrame;
    while (frame < lastFrame) {
      if (active[frame]) { frame += 1; continue; }
      const silenceStart = frame;
      while (frame < lastFrame && !active[frame]) frame += 1;
      if (frame - silenceStart >= minGapFrames) {
        ranges.push([rangeStart, Math.min(lastFrame, silenceStart + paddingFrames)]);
        rangeStart = Math.max(firstFrame, frame - paddingFrames);
      }
    }
    ranges.push([rangeStart, lastFrame]);

    const sampleRanges = ranges
      .map(([start, end]) => [start * frameSize, Math.min(mono.length, end * frameSize)] as const)
      .filter(([start, end]) => end > start);
    const totalSamples = sampleRanges.reduce((sum, [start, end]) => sum + end - start, 0);
    const compact = new Float32Array(totalSamples);
    let writeOffset = 0;
    for (const [start, end] of sampleRanges) {
      compact.set(mono.subarray(start, end), writeOffset);
      writeOffset += end - start;
    }
    const downsampled = resample(compact, audio.sampleRate, 16000);
    return { bytes: encodeWav(downsampled, 16000), mimeType: "audio/wav", durationMs: Math.round((downsampled.length / 16000) * 1000) };
  } finally {
    await context.close();
  }
}

export function useRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [levels, setLevels] = useState<number[]>(Array(18).fill(0.16));
  const [inputLevelDb, setInputLevelDb] = useState(-60);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const animationRef = useRef<number | null>(null);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    if (audioContextRef.current) void audioContextRef.current.close();
    audioContextRef.current = null;
    setLevels(Array(18).fill(0.16));
    setInputLevelDb(-60);
  }, []);

  useEffect(() => stopTracks, [stopTracks]);

  const animateLevels = useCallback((analyser: AnalyserNode) => {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const samples = new Float32Array(analyser.fftSize);
    let smoothedDb = -60;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const rms = Math.sqrt(energy / samples.length);
      const measuredDb = Math.max(-60, Math.min(0, 20 * Math.log10(Math.max(rms, 0.001))));
      const smoothing = measuredDb > smoothedDb ? 0.45 : 0.14;
      smoothedDb += (measuredDb - smoothedDb) * smoothing;
      setInputLevelDb(smoothedDb);
      setLevels(Array.from({ length: 18 }, (_, index) => {
        const bucket = Math.floor((index / 18) * data.length * 0.55);
        return Math.max(0.12, (data[bucket] ?? 0) / 255);
      }));
      animationRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    chunksRef.current = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
    recorder.start(200);
    recorderRef.current = recorder;
    streamRef.current = stream;
    audioContextRef.current = audioContext;
    startedAtRef.current = Date.now();
    setIsRecording(true);
    animateLevels(analyser);
  }, [animateLevels]);

  const stop = useCallback((options: StopOptions) => new Promise<Recording>((resolve, reject) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") { reject(new Error("No recording is active.")); return; }
    recorder.onerror = () => reject(new Error("The microphone recording failed."));
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      const originalDurationMs = Date.now() - startedAtRef.current;
      recorderRef.current = null;
      setIsRecording(false);
      stopTracks();
      if (options.trimSilence) {
        try {
          const trimmed = await trimToSpeech(blob, options.thresholdDb);
          if (!trimmed) { reject(new Error("No speech was detected, so nothing was sent.")); return; }
          resolve(trimmed);
          return;
        } catch (cause) {
          if (cause instanceof Error && cause.message.includes("No speech")) { reject(cause); return; }
          // If this WebView cannot decode its MediaRecorder format, safely fall back to the original audio.
        }
      }
      resolve({ bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: recorder.mimeType || blob.type, durationMs: originalDurationMs });
    };
    recorder.stop();
  }), [stopTracks]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") { recorder.onstop = null; recorder.stop(); }
    recorderRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
    stopTracks();
  }, [stopTracks]);

  return { isRecording, levels, inputLevelDb, start, stop, cancel };
}
