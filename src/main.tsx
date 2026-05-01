import React from "react"
import ReactDOM from "react-dom/client"
import { invoke } from "@tauri-apps/api/core"
import App from "./App"
import { AppErrorBoundary } from "@/components/AppErrorBoundary"
import { ThemeProvider } from "@/lib/theme"
import "./index.css"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="light">
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </ThemeProvider>
  </React.StrictMode>
)

window.requestAnimationFrame(() => {
  window.requestAnimationFrame(() => {
    invoke("frontend_ready").catch((e) => {
      console.error("frontend_ready failed:", e)
    })
  })
})
