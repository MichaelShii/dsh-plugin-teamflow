/**
 * tsdown 构建配置：client 半构建为 client-modules 可加载的 stamped bundle。
 *
 * 产物 lib/client.js 必须以 `window.__ModuleLoader__.load({ id, factory })`
 * 注册（CJS + banner/footer），否则浏览器端报
 * "bundle ... loaded without registering ... via __ModuleLoader__.load"。
 * 参考 @deepseek-ai/dsh-client-ui-* 的 clientBundle 输出契约：
 * - format cjs + platform browser，banner/footer/intro 三件套
 * - react 等平台模块保持 external（由 shell 的 module table 提供）
 * - 其余（相对路径代码、descriptors.js）全部内联
 * package.json exports["./client"] 指向本产物（lib/client.js）。
 */
import { defineConfig } from 'tsdown'

const ID = 'dsh-plugin-teamflow'

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  clean: false,
  sourcemap: true,
  external: ['react'],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
