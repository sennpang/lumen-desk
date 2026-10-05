import { BrowserWindow, dialog, ipcMain } from 'electron'

/**
 * 系统对话框 IPC（PRD 13.1 dialog 命名空间）
 *
 * 渲染端 <input type=file> 拿到的 File 在安全策略下没有真实磁盘路径，
 * 导入本地文件必须由主进程弹出系统选择框、拿到绝对路径后再读。
 */
export function registerDialogHandlers(): void {
  ipcMain.handle('dialog:pickFiles', async (): Promise<string[]> => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要导入的文档',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '知识库文档', extensions: ['pdf', 'docx', 'md', 'markdown', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })
}
