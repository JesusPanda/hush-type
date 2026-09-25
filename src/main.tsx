import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import OverlayApp from "./OverlayApp";
import "./styles.css";

const isOverlay = new URLSearchParams(window.location.search).has("overlay");
// Set before the first paint so the overlay window never flashes the app background.
if (isOverlay) document.documentElement.classList.add("overlay-document");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isOverlay ? <OverlayApp /> : <App />}
  </React.StrictMode>,
);
