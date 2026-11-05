import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// The webview's default context menu (reload, inspect) is not useful here.
if (!import.meta.env.DEV) document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
