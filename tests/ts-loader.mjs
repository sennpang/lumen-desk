// 测试运行时的 ESM loader 钩子。
//
// 两个职责：
// 1. 直接执行仓库里的 .ts 源码：Electron 内置 Node 24 自带类型擦除
//    （module.stripTypeScriptTypes），但 src 在 type:"commonjs" 包下，
//    Node 默认会按 CJS 解析 .ts，遇到 ESM import 语法报错。这里把
//    所有 .ts 强制标记为 module 格式并现场擦除类型，无需 tsc 预编译。
// 2. 支持 Vite 的 `import x from './x.sql?raw'`：把查询里的 ?raw 去掉
//    先解析到真实文件，load 时读文本返回 default 导出。
//
// 只用 Node 内置能力，测试零额外依赖。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const RAW_SUFFIX = '?raw'
const ELECTRON_STUB_URL = 'lumen-test-stub:electron'

export async function resolve(specifier, context, nextResolve) {
  // 以 ELECTRON_RUN_AS_NODE 运行时，electron 包只导出可执行文件路径字符串，
  // 源码里的 `import { app } from 'electron'` 会拿不到命名导出。
  // 仓储/切分层测试根本不需要 Electron 运行时，这里给个最小桩。
  if (specifier === 'electron') {
    return { url: ELECTRON_STUB_URL, shortCircuit: true }
  }
  if (specifier.endsWith(RAW_SUFFIX)) {
    const bare = specifier.slice(0, -RAW_SUFFIX.length)
    const resolved = await nextResolve(bare, context)
    return { url: resolved.url + RAW_SUFFIX, shortCircuit: true }
  }
  // 源码里的相对导入不带扩展名（TS 风格），ESM 默认解析不会补 .ts，
  // 依次尝试 .ts 与目录 index.ts。
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await nextResolve(candidate, context)
      } catch {
        // 试下一个候选
      }
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === ELECTRON_STUB_URL) {
    return {
      format: 'module',
      source: `
        import { tmpdir } from 'node:os'
        const app = {
          getPath: () => tmpdir(),
          getName: () => 'lumen-desk',
          getVersion: () => '0.0.0-test'
        }
        export { app }
        export default { app }
      `,
      shortCircuit: true
    }
  }
  if (url.endsWith(RAW_SUFFIX)) {
    const filePath = fileURLToPath(url.slice(0, -RAW_SUFFIX.length))
    const text = readFileSync(filePath, 'utf8')
    return {
      format: 'module',
      source: `export default ${JSON.stringify(text)};`,
      shortCircuit: true
    }
  }
  if (url.startsWith('file://') && url.endsWith('.ts')) {
    const filePath = fileURLToPath(url)
    // node_modules 内不会有需要类型擦除的 .ts
    if (filePath.includes('/node_modules/')) return nextLoad(url, context)
    const source = readFileSync(filePath, 'utf8')
    const js = stripTypeScriptTypes(source, { mode: 'transform' })
    return { format: 'module', source: js, shortCircuit: true }
  }
  return nextLoad(url, context)
}
