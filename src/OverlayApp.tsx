import { useEffect, useState } from "react";
import { Capsule } from "./components/Capsule";
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

  return (
    <div className="overlay-stage">
      <Capsule
        state={payload.state}
        color={payload.color}
        title={`${payload.profileName}: ${stateLabel[payload.state]}. Drag to move.`}
        onCancel={() => void requestOverlayCancel()}
        onMouseDown={(event) => {
          if (event.button === 0 && !(event.target as HTMLElement).closest("button")) {
            void startOverlayDrag();
          }
        }}
      />
    </div>
  );
}
