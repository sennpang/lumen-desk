import { useEffect, useState } from 'react'

/**
 * M0 验收页面：验证"渲染进程 -> preload 桥 -> 主进程"的 IPC 链路。
 *
 * 对应 PRD 里程碑 M0（W1）：桌面窗口 + IPC hello。
 * 页面加载后调用 window.api.ping()，主进程返回版本/平台信息，
 * 证明双进程通信已经跑通，后续所有功能（流式对话/知识库/Agent）都建立在此之上。
 */
interface Pong {
  pong: boolean
  version: string
  platform: string
  time: number
}

export function App() {
  const [pong, setPong] = useState<Pong | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api
      .ping()
      .then((res) => {
        console.log('[M0] app:ping 返回：', res)
        setPong(res)
      })
      .catch((e: unknown) => {
        console.error('[M0] app:ping 失败：', e)
        setError(String(e))
      })
  }, [])

  return (
    <main className="m0">
      <h1>Lumen Desk</h1>
      <p className="subtitle">本地知识库 AI 桌面助手 · M0 骨架</p>

      <section className="probe">
        {error && <p className="error">IPC 调用失败：{error}</p>}
        {!pong && !error && <p>正在通过 IPC 询问主进程…</p>}
        {pong && (
          <>
            <p className="ok">✓ IPC 链路已打通（app:ping → pong）</p>
            <dl>
              <dt>应用版本</dt>
              <dd>{pong.version}</dd>
              <dt>平台</dt>
              <dd>{pong.platform}</dd>
              <dt>主进程时间戳</dt>
              <dd>{pong.time}</dd>
            </dl>
          </>
        )}
      </section>
    </main>
  )
}
