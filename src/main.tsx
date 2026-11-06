import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TrayHud } from "./components/TrayHud";

const trayView = new URLSearchParams(window.location.search).get("view") === "tray";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {trayView ? <TrayHud /> : <App />}
  </React.StrictMode>,
);
