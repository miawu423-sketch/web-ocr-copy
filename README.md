# Web OCR Copy

一个 Chrome / Edge 扩展 —— 在网页上框选任意区域，本地 OCR 识别后自动复制到剪贴板，不用再切到微信/企微截图 OCR。

## 特性
- **框选即复制**：按 `⌃+Shift+O`（Windows/Linux 是 `Ctrl+Shift+O`）或右键菜单唤起，拖拽框选，松开鼠标 → 自动复制
- **本地识别**：使用 Tesseract.js（`chi_sim + eng`），不上传任何数据，离线可用
- **两种模式**：默认直接复制并 toast 提示；**按住 Shift 拖拽** 会弹预览浮层，可编辑后再复制
- **智能兜底**：`chrome://` 等特殊页面会给出提示；剪贴板 API 失败时用 execCommand 兜底

## 安装（开发者模式加载）

1. 打开 Chrome/Edge，地址栏输入 `chrome://extensions/`（Edge 是 `edge://extensions/`）
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本目录 `web-ocr-copy/`
5. 图标出现在工具栏后，建议点它右侧的 📌 固定住

## 使用

三种方式启动，任选一种：
- 快捷键 `⌃+Shift+O`（Mac Control+Shift+O；Windows/Linux: `Ctrl+Shift+O`；如需修改请打开 `chrome://extensions/shortcuts`）
- 点击工具栏上的扩展图标
- 网页任意位置右键 → **OCR 框选复制**

启动后：
- 拖拽画一个矩形 → 松开
- 等 1-3 秒（首次会加载 20MB 语言包，会稍慢，之后走缓存秒开）
- 底部 toast 提示 **已复制 N 个字符** → 直接 `Cmd+V` 粘贴

**Shift 预览模式**：拖拽时按住 Shift，识别完会弹一个可编辑框，你可以修改错字再点复制。

按 `Esc` 随时取消框选。

## 文件结构

```
web-ocr-copy/
├── manifest.json          扩展清单 (MV3)
├── background.js          Service Worker：快捷键/右键/图标点击 → 触发 content
├── content.js             蒙层框选 + 截图 + OCR 主流程
├── content.css            蒙层/toast/预览浮层样式
├── icons/                 三种尺寸图标
└── lib/
    ├── html2canvas.min.js         DOM 截图
    ├── tesseract.min.js           OCR 主库
    ├── worker.min.js              OCR Worker
    ├── tesseract-core.wasm.js     OCR WASM 加载器
    ├── chi_sim.traineddata.gz     中文简体语言包
    └── eng.traineddata.gz         英文语言包
```

## 已知限制 / 后续可以加的功能

- **PDF 内嵌页**：Chrome 的 PDF 查看器是 native 组件，无法注入内容脚本，暂不支持（工作流是先在浏览器打开的 PDF 页也可以用系统截图 + 本扩展粘贴到临时页识别，稍麻烦）
- **iframe 跨域**：跨域 iframe 里的内容 html2canvas 拿不到，会截成空白 —— 这是浏览器安全限制
- **繁体 / 日文**：如需可再下 `chi_tra.traineddata.gz` / `jpn.traineddata.gz` 放到 `lib/`，然后在 `content.js` 里改 `"chi_sim+eng"` 为需要的组合
- **云端 OCR 切换**：若某些字体识别率不满意，可以再加一个"云端 OCR"选项（云端 OCR 服务都有免费额度），在 popup 里做个开关

## 隐私

- 所有 OCR 计算在你本机浏览器里完成，不发送任何数据到外部服务器
- 扩展只在你主动触发时才截图当前视口的**你框选的那一小块区域**
- 不收集、不存储任何识别历史
