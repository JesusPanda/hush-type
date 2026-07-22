import { useEffect, useState } from "react";
import { Check, Mic, Sparkles, X } from "lucide-react";
import { onOverlayState, requestOverlayCancel, startOverlayDrag, type OverlayPayload } from "./lib/bridge";

const initial: OverlayPayload = {
  visible: false,
  state: "idle",
  profileName: "Dictation",
  cleanupEnabled: false,
};

export default function OverlayApp() {
  const [payload, setPayload] = useState(initial);
  useEffect(() => {
    document.documentElement.classList.add("overlay-document");
    let unlisten: () => void = () => undefined;
    void onOverlayState(setPayload).then((stop) => { unlisten = stop; });
    return () => { unlisten(); document.documentElement.classList.remove("overlay-document"); };
  }, []);

  return (
    <div
      className={`floating-overlay state-${payload.state}`}
      onMouseDown={(event) => {
        if (event.button === 0 && !(event.target as HTMLElement).closest("button")) {
          void startOverlayDrag();
        }
      }}
      title="Drag to move"
    >
      <div className="overlay-mode-icon">
        {payload.state === "success" ? <Check size={18} /> : payload.cleanupEnabled ? <Sparkles size={18} /> : <Mic size={18} />}
      </div>
      <div className="overlay-copy">
        <strong>{payload.profileName}</strong>
        <span>{payload.state === "recording" ? "Listening" : payload.state === "processing" ? "Running pipeline" : payload.state === "success" ? "Pasted" : payload.state === "error" ? "Something went wrong" : "Ready"}</span>
      </div>
      <div className="overlay-wave" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => <i key={index} style={{ animationDelay: `${index * -0.07}s` }} />)}
      </div>
      <button className="overlay-cancel" onClick={() => void requestOverlayCancel()} title="Cancel and discard"><X size={16} /></button>
    </div>
  );
}
