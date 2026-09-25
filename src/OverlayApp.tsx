import { useEffect, useState } from "react";
import { Check, CircleAlert, Mic, Sparkles, X } from "lucide-react";
import { onOverlayState, requestOverlayCancel, startOverlayDrag, type OverlayPayload } from "./lib/bridge";

const initial: OverlayPayload = {
  visible: false,
  state: "idle",
  profileName: "Dictation",
  cleanupEnabled: false,
};

const stateLabel: Record<OverlayPayload["state"], string> = {
  idle: "Ready",
  recording: "Listening",
  processing: "Working",
  success: "Pasted",
  error: "Something went wrong",
};

export default function OverlayApp() {
  const [payload, setPayload] = useState(initial);
  useEffect(() => {
    document.documentElement.classList.add("overlay-document");
    let unlisten: () => void = () => undefined;
    void onOverlayState(setPayload).then((stop) => { unlisten = stop; });
    return () => { unlisten(); document.documentElement.classList.remove("overlay-document"); };
  }, []);

  const icon = payload.state === "success"
    ? <Check size={15} strokeWidth={2.4} />
    : payload.state === "error"
      ? <CircleAlert size={15} strokeWidth={2.2} />
      : payload.cleanupEnabled ? <Sparkles size={15} strokeWidth={2} /> : <Mic size={15} strokeWidth={2} />;

  return (
    <div className="overlay-stage">
      <div
        className={`overlay-pill state-${payload.state}`}
        onMouseDown={(event) => {
          if (event.button === 0 && !(event.target as HTMLElement).closest("button")) {
            void startOverlayDrag();
          }
        }}
        title={`${payload.profileName} · ${stateLabel[payload.state]} — drag to move`}
      >
        <div className="overlay-icon">{icon}</div>
        <button className="overlay-cancel" onClick={() => void requestOverlayCancel()} title="Cancel and discard" aria-label="Cancel and discard"><X size={13} strokeWidth={2.4} /></button>
      </div>
    </div>
  );
}
