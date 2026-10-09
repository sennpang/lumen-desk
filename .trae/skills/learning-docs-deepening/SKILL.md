---
name: learning-docs-deepening
description: Extend lumen-desk learning handouts with code-verified deep-dive sections or quiz items. Use for 深入章节/自测题/按深度补全 docs/learning M0-M6. Do not use for application code changes.
---

# 学习讲义深化（深入章节 / 自测题）

本项目（lumen-desk）是 Electron + React + TS 学习项目，讲义在 `docs/learning/Mx-*.md`。核心原则：**讲义是对照真实代码的学习材料，不是凭印象写的教程**。

## 工作流程

### 1. 先核实代码，再动笔

- 每个论断都先 Read 对应源码确认；函数名、字段名、常量、阈值、默认值必须与代码逐字一致。
- 数值型论断（分数、概率、阈值、字节序列）写完后自己重新演算一遍；发现旧文档说法错误，顺手改正旧内容，并在该章 commit message 里单独说明校正点（M4 的 0.30 boost 就是先例）。
- 代码引用一律用相对链接 `../../src/...`，不要写机器绝对路径。

### 2. 插入位置与格式

- 深入章节插在「## 踩坑记录」**之前**；Edit 前必须重新 Read 确认锚点原文（各文件章节位置不同）。
- 标题：`## 深入：…`，子节用 `### A. …`、`### B. …` 字母编号。
- 自测题追加在「## 自测题」编号末尾，参考答案同步追加在「## 自测题参考答案」末尾，答案用 `**N. 题干**` 开头；旧题保持不动。
- 补题前先通读现有题目与深入子节，只补未覆盖的点，避免同知识点换皮重复。
- 文档语言中文；代码示例可简化，但标识符与数值不许虚构。
- 不要改动自测题以外既有结构，不要新建 README/索引文件。

### 3. 提交规范

- 每个里程碑（每章）单独一个 commit，先精确 `git add docs/learning/Mx-*.md`（禁止 add 全仓；`.obsidian/` 已被 gitignore，切勿带入）。
- commit message 用 heredoc，详细列出做了什么与关键知识点：

  ```bash
  git commit -m "$(cat <<'EOF'
  docs(Mx): 标题
  - 要点
  EOF
  )"
  ```

- **外置 SSD 上所有 git 命令必须在无 sandbox 环境执行**（EXDEV 拦截会导致失败）。
- 一批章节完成后统一 `git push origin main`。

### 4. 边界

- 仅改文档时不需要 typecheck/测试；若发现代码问题，只做用户明确要求的事，不顺手改代码。
- shared 协议以 `src/shared/protocol.ts`、`src/shared/types.ts` 为准；不确定的运行时行为先读代码或测试，不猜测。
