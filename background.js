// background service worker
// 职责：
//   1. 监听快捷键 / 右键菜单 / action 点击，向当前 tab 的 content script 发送启动信号
//   2. 管理 offscreen document 生命周期（用它跑 Tesseract，绕开网页 CSP）
//   3. 把 content script 的 OCR 请求转发给 offscreen，再把结果转发回去

const START_MSG = { type: "START_OCR_SELECTION" };
const OFFSCREEN_URL = "offscreen.html";

// 安装/更新时创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ocr-copy",
    title: "OCR 框选复制",
    contexts: ["page", "selection", "image", "frame"]
  });
});

// ========== Offscreen document 管理 ==========

async function hasOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    return await chrome.offscreen.hasDocument();
  }
  // 兼容老版本：靠 getContexts 查
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    return contexts.length > 0;
  }
  return false;
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"], // 我们就是为了创建 Web Worker 跑 Tesseract
    justification: "运行 Tesseract.js OCR Web Worker（本地识别，不发送任何数据）"
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

// ========== 消息路由 ==========
//
// content.js 发来 { type: "ocr-request", id, imageDataURL }
//   → 确保 offscreen 存在
//   → 转发到 offscreen（target: "offscreen"）
//   → 把 offscreen 的回复返回给 content.js
//
// offscreen 发来 { type: "ocr-progress", id, status, progress }
//   → 转发到发起请求的 tab 的 content script

const pendingTabByRequestId = new Map(); // id -> tabId

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "ocr-request") {
    const tabId = sender.tab && sender.tab.id;
    const id = msg.id;
    if (tabId != null) pendingTabByRequestId.set(id, tabId);

    (async () => {
      try {
        await ensureOffscreen();
        // 把请求转给 offscreen（它监听 target === "offscreen"）
        const response = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "ocr-request",
          id,
          imageDataURL: msg.imageDataURL
        });
        sendResponse(response);
      } catch (err) {
        sendResponse({ type: "ocr-response", id, ok: false, error: err && (err.message || String(err)) });
      } finally {
        pendingTabByRequestId.delete(id);
      }
    })();
    return true; // keep channel open for async sendResponse
  }

  if (msg.type === "ocr-progress") {
    // 来自 offscreen，转发给对应 tab
    const tabId = pendingTabByRequestId.get(msg.id);
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    }
  }
});

// ========== OCR 触发入口 ==========

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
