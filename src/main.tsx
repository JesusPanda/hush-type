import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import OverlayApp from "./OverlayApp";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).has("overlay") ? <OverlayApp /> : <App />}
  </React.StrictMode>,
);
