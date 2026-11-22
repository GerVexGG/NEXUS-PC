import React from "react";
import ReactDOM from "react-dom/client";
import "./App.css";
import { initializeAuroraAppearance } from "./lib/auroraAppearance";

initializeAuroraAppearance();
const trayView = new URLSearchParams(window.location.search).get("view") === "tray";
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

function render(View: React.ComponentType) {
  root.render(<React.StrictMode><View /></React.StrictMode>);
}

if (trayView) {
  void import("./components/TrayHud").then(({ TrayHud }) => render(TrayHud));
} else {
  void import("./App").then(({ default: App }) => render(App));
}
