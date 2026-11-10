// offscreen.js —— 在扩展自己的 origin 里跑 Tesseract OCR
// 这里不受网页 CSP 限制，可以自由创建 Web Worker。
//
// 协议：
//   收到 { type: "ocr-request", id, imageDataURL }
//   回复 { type: "ocr-response", id, ok: true, text }
//        或 { type: "ocr-response", id, ok: false, error }
//   过程中会推送 { type: "ocr-progress", id, status, progress }

let workerPromise = null;

function log(...args) {
  try { console.log("[web-ocr-copy][offscreen]", ...args); } catch {}
}

function getWorker(progressSink) {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    log("createWorker start");
    const T = self.Tesseract || globalThis.Tesseract || window.Tesseract;
    if (!T) throw new Error("Tesseract 未加载");

    const workerPath = chrome.runtime.getURL("lib/worker.min.js");
    const corePath = chrome.runtime.getURL("lib/tesseract-core.wasm.js");
    const langPath = chrome.runtime.getURL("lib/");

    const w = await T.createWorker("chi_sim+eng", 1, {
      workerPath,
      corePath,
      langPath,
      cacheMethod: "readOnly",
      logger: (m) => {
        log("tesseract", m);
        if (typeof progressSink === "function") progressSink(m);
      },
      errorHandler: (err) => log("tesseract-error", err)
    });

    await w.setParameters({
      tessedit_pageseg_mode: "6",
      preserve_interword_spaces: "1",
      user_defined_dpi: "300"
    });

    log("createWorker ok");
    return w;
  })().catch((e) => { workerPromise = null; throw e; });
  return workerPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "ocr-request") return;

  const id = msg.id;
  const sendProgress = (m) => {
    chrome.runtime.sendMessage({
      type: "ocr-progress",
      id,
      status: m && m.status,
      progress: m && m.progress
    }).catch(() => {});
  };

  (async () => {
    try {
      log("received ocr-request", id, "dataURL length:", msg.imageDataURL && msg.imageDataURL.length);
      const worker = await getWorker(sendProgress);
      // Tesseract 支持直接吃 dataURL
      const { data } = await worker.recognize(msg.imageDataURL);
      log("recognize done, text length:", data.text && data.text.length);
      sendResponse({ type: "ocr-response", id, ok: true, text: data.text || "" });
    } catch (err) {
      log("recognize error", err);
      sendResponse({ type: "ocr-response", id, ok: false, error: err && (err.message || String(err)) });
    }
  })();

  return true; // 保持异步 sendResponse 通道开着
});

log("offscreen.js ready");
