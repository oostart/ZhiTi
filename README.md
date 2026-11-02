# 知题 · AI 智能题库

面向中小学教师的桌面端智能题库工具。把 PDF 试卷转化为可检索、可编辑、可导出的本地题库，并集成 OCR 与 AI 辅助处理。

## 功能

- **PDF 导入**：拖拽导入试卷，自动解析页数并保存原始文件，可随时继续切割。
- **题目切割**：切线模式快速分题；框选模式精确圈题；支持跨页、多区域纵向合并为一道题。
- **OCR 识别**：数字版 PDF 优先读取文本层；扫描件使用 Tesseract.js 本地识别，支持人工校对。
- **AI 辅助**：生成参考答案、推荐知识点、生成题目理解；兼容 DeepSeek、通义千问及任意 OpenAI 兼容接口。
- **题库管理**：题干、答案、题型、难度、知识点编辑；关键词检索 + 年份/学科/年级/题型/难度/出处多维筛选。
- **题目导出**：学生版 PDF、教师版 PDF、可编辑 Word、一题一页 PPT、图片素材包 ZIP；导出时可自选保存位置。

## 技术栈

- 前端：Vue 3 + TypeScript + Vite
- 桌面端：Tauri 2 + Rust
- PDF：pdf.js（预览与文本层）、pdf-lib（导出）
- OCR：Tesseract.js
- 本地存储：本地 JSON 文件 + 原始 PDF（数据目录在首次启动时选择，默认软件同级目录下的「StudySI数据」）
- 导出：docx、PptxGenJS、JSZip

## 本地开发

环境要求：Node.js 20+、Rust（`stable-x86_64-pc-windows-msvc`）、Visual Studio Build Tools（C++ 工作负载 + Windows SDK）、WebView2 Runtime。

```bash
npm install
npm run dev          # 浏览器开发预览
npm run tauri dev    # 桌面端开发运行
```

## 构建

```bash
npm run build        # 仅构建前端，产物在 dist/
npm run tauri build  # 构建桌面端及安装包
```

Windows 安装包输出位置：

- `src-tauri/target/release/bundle/nsis/`（NSIS 安装包，推荐分发给教师）
- `src-tauri/target/release/bundle/msi/`（MSI，适合学校批量部署）
- `src-tauri/target/release/zhiti.exe`（免安装可执行文件）

## 数据与隐私

- 所有试卷、题目、设置与原始 PDF 均保存在用户选择的本地数据目录，不上传云端。
- 数据目录可在「设置 → 本地数据」中查看、打开或更改；备份时直接复制该目录即可。
- AI API 密钥仅保存在本地数据目录，调用时直接请求配置的接口。
- 浏览器环境下部分 AI 服务可能受跨域限制；桌面端不受影响。

## 已知限制

- 安装包当前未做代码签名，首次运行可能触发 Windows SmartScreen 提示。
- 桌面端数据以本地文件保存，请勿在应用运行中手动修改数据目录内的文件。
- 扫描件 OCR 准确率依赖图片清晰度，识别结果需人工校对。

## 发布

源码通过 Git 管理，安装包通过 GitHub Releases 分发，不在仓库中提交构建产物。
打 tag 后推送到 GitHub 会自动触发 `.github/workflows/release.yml` 构建 Windows 安装包并创建草稿 Release。
