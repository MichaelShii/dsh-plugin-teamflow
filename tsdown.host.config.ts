/**
 * tsdown host 构建配置：host/service/store/descriptors 的 TS 源码 → lib/*.js。
 *
 * 为什么 host 也要构建：Node 22 的 type stripping 对 node_modules 下的文件
 * 不生效（"Stripping types is currently unsupported for files under node_modules"），
 * 而 DSH 宿主组合从 profile/node_modules 加载插件 → .ts 源码无法直跑，必须构建为 .js。
 * 与 DSH 生态一致（@deepseek-ai/dsh-* 宿主包 exports 均指向 lib/*.js）。
 *
 * 产物：lib/host.js / lib/store.js / lib/descriptors.js（ESM，@deepseek-ai/* 保持 external）。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-plugin-teamflow/host',
  entry: {
    host: 'host/index.ts',
    store: 'store.ts',
    descriptors: 'descriptors.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: false,
  sourcemap: false,
  external: [/^@deepseek-ai\//],
})
