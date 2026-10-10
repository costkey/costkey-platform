import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { initAnalytics } from "./analytics.ts";
import BootScreen from "./BootScreen";
import { installFieldValidation } from "./fieldValidation";

const rootElement = document.getElementById("root");

if (!rootElement) {
  // The host document is broken; there is nowhere safe to mount the app.
  throw new Error("CostKey root element is missing");
}

const appRoot = createRoot(rootElement);

function render(node: ReactNode): void {
  appRoot.render(<StrictMode>{node}</StrictMode>);
}

installFieldValidation();
render(<BootScreen />);
void initAnalytics().catch(() => {});

// The observatory console is the product UI now, so it is always rendered by
// the normal React application. The optional design query only controls the
// local synthetic fixture adapter; it must never be required for the visual
// system and must never replace the live API path for real sessions.
const syntheticFixtureRequested = new URLSearchParams(window.location.search).get("design") === "prototype"
  || import.meta.env.VITE_DESIGN_PREVIEW === "true";
const appModule = syntheticFixtureRequested
  ? import("./prototypePreview").then(({ installPrototypePreview }) => installPrototypePreview()).then(() => import("./App.tsx"))
  : import("./App.tsx");
void appModule
  .then(({ default: App }) => render(<App />))
  .catch((reason: unknown) => {
    if (import.meta.env.DEV) {
      const detail = reason instanceof Error ? { name: reason.name, message: reason.message, stack: reason.stack } : String(reason);
      console.error("[costkey] app module failed to load", detail);
    }
    render(<BootScreen fatal />);
  });
