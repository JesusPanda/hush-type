import type { CSSProperties, MouseEventHandler } from "react";
import { Check, X } from "lucide-react";
import type { RecordingState } from "../types";

const BAR_COUNT = 5;

interface CapsuleProps {
  state: RecordingState;
  color?: string;
  title?: string;
  /** Live microphone levels (0–1). Without them the bars move on their own while recording. */
  levels?: number[];
  onCancel?: () => void;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
  preview?: boolean;
}

/** The floating recording pill: a few bars in the mode's pigment and a quiet cancel. */
export function Capsule({ state, color, title, levels, onCancel, onMouseDown, preview }: CapsuleProps) {
  const sampled = levels?.length
    ? Array.from({ length: BAR_COUNT }, (_, index) => levels[Math.floor(((index + 0.5) / BAR_COUNT) * levels.length)] ?? 0)
    : undefined;
  return (
    <div
      className={`capsule state-${state} ${sampled ? "live" : ""} ${preview ? "preview" : ""}`}
      style={color ? ({ "--pig": color } as CSSProperties) : undefined}
      onMouseDown={onMouseDown}
      title={title}
    >
      <span className="capsule-glyph" aria-hidden="true">
        {state === "success"
          ? <Check size={15} strokeWidth={2.6} />
          : state === "error"
            ? <b>!</b>
            : Array.from({ length: BAR_COUNT }, (_, index) => (
              <i key={index} style={sampled ? { transform: `scaleY(${Math.max(0.18, Math.min(1, sampled[index] * 1.15))})` } : undefined} />
            ))}
      </span>
      <button type="button" className="capsule-cancel" onClick={onCancel} tabIndex={preview ? -1 : undefined} title="Cancel and discard" aria-label="Cancel and discard"><X size={12} strokeWidth={2.4} /></button>
    </div>
  );
}
