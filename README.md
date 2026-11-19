<div align="center">
  <img src="./ye.png" alt="知题 · AI 智能题库" width="140" />

  <h1>知题 · AI 智能题库</h1>

  <p>面向中小学教师的本地桌面端智能题库工具：把 PDF / Word 试卷转化为结构化、可检索、可编辑、可导出的数字题库。</p>

  <p>
    <img alt="version" src="https://img.shields.io/badge/version-2.1.0-c0562e" />
    <img alt="platform" src="https://img.shields.io/badge/platform-Windows-4a4a4a" />
    <img alt="license" src="https://img.shields.io/badge/license-MIT-c0562e" />
  </p>
</div>

## 功能

- **试卷导入**：支持 PDF 与 Word（.docx）试卷，自动解析页数并本地保存原始文件，可随时回到切割页继续处理。
- **题目切割**：框选模式精确圈题；支持跨页、多区域纵向合并为一道题；可同时框选参考答案区域。
- **题目文档**：视觉模型把题目识别为「文字 + LaTeX 公式 + 图形」的可编辑文档，支持逐题校对；「一键识别」可批量处理所有未识别的题目。
- **参考答案**：框选答案区域后由 AI 识别（含公式与插图）并结构化保存，也可在题目文档中手动补充。
- **AI 辅助**：识别题目、生成参考答案、推荐知识点、生成题目理解；兼容 DeepSeek、通义千问及任意 OpenAI 兼容接口，文本模型与视觉模型可分别配置。
- **题库管理**：题干、答案、题型、难度、知识点在线编辑；关键词检索 + 年份/学科/年级/题型/难度/出处多维筛选。
- **题目导出**：PDF、Word（文字可编辑，公式为 Word 原生公式）、一题一页 PPT、题目原图素材包 ZIP；可调整题目顺序、标题、编号、是否附答案、页面尺寸与内容宽度。

## 技术栈

- 前端：Vue 3 + TypeScript + Vite
- 桌面端：Tauri 2 + Rust
- 富文本与公式：TipTap / ProseMirror + KaTeX
- PDF：pdf.js（预览与文本层）、pdf-lib（导出）
- Word：docx（导出）、docx-preview（导入预览）
- 本地存储：本地 JSON 文件 + 原始试卷文件（默认保存在软件同级目录下的「StudySI数据」，可在设置中更改）
- 导出：pdf-lib、docx、PptxGenJS、JSZip、html-to-image

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

- 所有试卷、题目、设置与原始文件均保存在本地数据目录，不上传云端。
- 数据目录可在「设置 → 本地数据」中查看、打开或更改；备份时直接复制该目录即可。
- AI API 密钥仅保存在本地数据目录，调用时直接请求配置的接口。
- 浏览器环境下部分 AI 服务可能受跨域限制；桌面端不受影响。

## 已知限制

- 安装包当前未做代码签名，首次运行可能触发 Windows SmartScreen 提示。
- 桌面端数据以本地文件保存，请勿在应用运行中手动修改数据目录内的文件。
- 图片题与扫描件依赖视觉模型识别，公式、图形与答案结果需人工校对。

## 发布

源码通过 Git 管理，安装包通过 GitHub Releases 分发，不在仓库中提交构建产物。
打 tag 后推送到 GitHub 会自动触发 `.github/workflows/release.yml` 构建 Windows 安装包并创建草稿 Release。

## 许可证

本项目基于 [MIT License](LICENSE) 开源，可自由使用、修改与分发。

Copyright (c) 2026 oostart
