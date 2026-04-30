import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath, URL } from "node:url"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    hmr: { protocol: "ws", host: "127.0.0.1", port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] }
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined
          const norm = id.replace(/\\/g, "/")
          if (/[\\/]node_modules[\\/](\.pnpm[\\/])?(react|react-dom|scheduler)[@\\/]/.test(norm)) {
            return "react"
          }
          if (norm.includes("@radix-ui")) return "radix"
          if (norm.includes("lucide-react")) return "icons"
          if (
            norm.includes("react-markdown") ||
            norm.includes("remark-") ||
            norm.includes("rehype-") ||
            norm.includes("/micromark") ||
            norm.includes("/mdast-") ||
            norm.includes("/hast-") ||
            norm.includes("/unified") ||
            norm.includes("/unist-") ||
            norm.includes("/vfile") ||
            norm.includes("/bail") ||
            norm.includes("/trough") ||
            norm.includes("/decode-named-character-reference") ||
            norm.includes("/character-entities") ||
            norm.includes("/property-information") ||
            norm.includes("/space-separated-tokens") ||
            norm.includes("/comma-separated-tokens") ||
            norm.includes("/zwitch") ||
            norm.includes("/devlop") ||
            norm.includes("/longest-streak") ||
            norm.includes("/markdown-table") ||
            norm.includes("/ccount") ||
            norm.includes("/escape-string-regexp")
          ) {
            return "markdown"
          }
          if (norm.includes("highlight.js") || norm.includes("/lowlight")) {
            return "highlight"
          }
          return undefined
        }
      }
    }
  }
})
