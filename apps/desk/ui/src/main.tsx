import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadAppInfo } from "./appInfo";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

createRoot(root).render(
  <StrictMode>
    <App loadInfo={loadAppInfo} />
  </StrictMode>,
);
