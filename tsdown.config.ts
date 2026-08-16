/**
 * tsdown 构建配置（发布前构建 client 用）。
 *
 * 参考 @deepseek-ai/dsh-client-ui-* 的构建管线：tsdown 打包为 ESM，
 * host 侧无需构建（宿主直接加载 ESM 源码）。构建产物 lib/client.js
 * 对应 package.json exports["./client"]（发布时改为 "./lib/client.js"）。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { client: 'client/index.js' },
  format: ['esm'],
  outDir: 'lib',
  // @deepseek-ai/* 与 react 由宿主 web bundle 提供，不打进产物
  external: [/^@deepseek-ai\//, 'react'],
  sourcemap: true,
})
