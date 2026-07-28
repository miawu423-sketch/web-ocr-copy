// background service worker
// 职责：监听快捷键 / 右键菜单 / action 点击，向当前 tab 的 content script 发送启动信号

const START_MSG = { type: "START_OCR_SELECTION" };

// 安装/更新时创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ocr-copy",
    title: "OCR 框选复制",
    contexts: ["page", "selection", "image", "frame"]
  });
});

// 通用触发入口：向指定 tab 发消息，如果 content script 没就绪则动态注入后再发
async function triggerOcr(tab) {
  if (!tab || !tab.id) return;
  const url = tab.url || "";
  // chrome:// / edge:// / chrome-extension:// 等特殊页面无法注入
  if (/^(chrome|edge|about|chrome-extension|devtools):/i.test(url)) {
    chrome.action.setBadgeText({ text: "!", tabId: tab.id });
    chrome.action.setBadgeBackgroundColor({ color: "#e11d48", tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: tab.id }), 2500);
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, START_MSG);
  } catch (e) {
    // content script 可能未注入（例如扩展刚安装、页面早于扩展加载）
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          "lib/html2canvas.min.js",
          "lib/tesseract-shim.js",
          "lib/tesseract.min.js",
          "lib/tesseract-restore.js",
          "content.js"
        ]
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["content.css"]
      });
      await chrome.tabs.sendMessage(tab.id, START_MSG);
    } catch (err) {
      console.error("[web-ocr-copy] 无法启动:", err);
    }
  }
}

// 快捷键
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "start-ocr") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  triggerOcr(tab);
});

// 右键菜单
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "ocr-copy") triggerOcr(tab);
});

// 工具栏图标点击
chrome.action.onClicked.addListener((tab) => {
  triggerOcr(tab);
});
