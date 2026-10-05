/**
 * 主进程侧非代码资源的类型声明
 * electron-vite（Vite）以 ?raw 后缀把文件内容作为字符串内联进 bundle，
 * 打包后不依赖磁盘上的 .sql 文件存在（asar 内也能正常用）。
 */
declare module '*.sql?raw' {
  const content: string
  export default content
}
