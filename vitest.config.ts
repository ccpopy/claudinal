import { defineConfig, mergeConfig } from "vitest/config"
import viteConfig from "./vite.config"

// 测试只需要 vite alias 解析；不复用 vite plugins/build/server 等部分。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      environment: "node",
      // 组件测试用 react-dom/server 静态渲染断言 markup；不需要 jsdom。
      globals: false
    }
  })
)
