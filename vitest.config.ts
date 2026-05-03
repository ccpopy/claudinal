import { defineConfig, mergeConfig } from "vitest/config"
import viteConfig from "./vite.config"

// 测试只需要 vite alias 解析；不复用 vite plugins/build/server 等部分。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts"],
      environment: "node",
      // 测试只跑纯函数：reducer / 工具函数；不需要 jsdom。
      globals: false
    }
  })
)
