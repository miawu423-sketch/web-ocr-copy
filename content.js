/**
 * Web OCR Copy — content script
 *
 * 流程：
 *  1. 收到 background 的 START_OCR_SELECTION 消息 → 注入蒙层
 *  2. 用户拖拽画框 → 松开鼠标记录矩形（同时记录是否按住 Shift）
 *  3. 移除蒙层（关键！html2canvas 截图时不能包含我们自己的蒙层）
 *  4. 用 html2canvas 截取该矩形区域的高清图
 *  5. 加载 Tesseract 并识别
 *  6. 默认：复制到剪贴板 + toast；Shift：弹预览浮层
 */

(() => {
  // 防重入：如果已经在选择或识别，忽略新的启动信号
  if (window.__WEB_OCR_COPY_INITED__) return;
  window.__WEB_OCR_COPY_INITED__ = true;

  let isSelecting = false;
  let isBusy = false;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "START_OCR_SELECTION" && !isSelecting && !isBusy) {
      startSelection();
    }
  });

  // ================= 框选 =================

  function startSelection() {
    isSelecting = true;

    const overlay = document.createElement("div");
    overlay.id = "__web_ocr_overlay__";

    const rect = document.createElement("div");
    rect.id = "__web_ocr_rect__";
    rect.style.display = "none";

    const hint = document.createElement("div");
    hint.id = "__web_ocr_hint__";
    hint.textContent = "拖拽框选要复制的区域 · 按 Esc 取消";

    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(rect);
    document.documentElement.appendChild(hint);

    let startX = 0, startY = 0;
    let curX = 0, curY = 0;
    let dragging = false;
    let shiftHeld = false;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      shiftHeld = e.shiftKey;
      startX = e.clientX;
      startY = e.clientY;
      rect.style.display = "block";
      updateRect();
    };

    const onMouseMove = (e) => {
      if (!dragging) return;
      curX = e.clientX;
      curY = e.clientY;
      updateRect();
    };

    const onMouseUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const box = getBox();
      cleanupSelection();
      if (box.w < 5 || box.h < 5) {
        isSelecting = false;
        return; // 太小视作误触
      }
      isSelecting = false;
      processCapture(box, shiftHeld || e.shiftKey);
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        cleanupSelection();
        isSelecting = false;
      }
    };

    function updateRect() {
      const b = getBox();
      rect.style.left = b.x + "px";
      rect.style.top = b.y + "px";
      rect.style.width = b.w + "px";
      rect.style.height = b.h + "px";
    }

    function getBox() {
      return {
        x: Math.min(startX, curX),
        y: Math.min(startY, curY),
        w: Math.abs(curX - startX),
        h: Math.abs(curY - startY)
      };
    }

    function cleanupSelection() {
      overlay.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      rect.remove();
      hint.remove();
    }

    overlay.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
  }

  // ================= 截图 + OCR =================

  async function processCapture(box, preview) {
    isBusy = true;
    const toast = showToast("正在截图并识别，请稍候…", "loading", 0);

    try {
      // html2canvas 是全局挂载在 window 上的（由 lib/html2canvas.min.js 提供）
      if (typeof window.html2canvas !== "function") {
        throw new Error("html2canvas 未加载");
      }

      // 视口坐标 → 页面坐标（html2canvas 用的是文档坐标）
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;

      const canvas = await window.html2canvas(document.body, {
        x: box.x + scrollX,
        y: box.y + scrollY,
        width: box.w,
        height: box.h,
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#ffffff", // 给一个白底，避免透明像素影响二值化
        scale: Math.max(window.devicePixelRatio || 1, 3), // 提到 3x，中文字更清晰
        logging: false
      });

      // 预处理：灰度 + 对比度增强 + 自适应二值化
      const processed = preprocessForOcr(canvas);

      updateToast(toast, "识别中…（首次会加载语言包）", "loading");

      const text = await runOcr(processed);
      const cleaned = cleanOcrText(text || "");

      if (!cleaned) {
        updateToast(toast, "未识别到文字", "error");
        setTimeout(() => toast.remove(), 2000);
        return;
      }

      // 统一走"编辑浮层"：识别完先弹浮层给用户编辑，一键复制。
      // 同时后台悄悄把原始文本也塞进剪贴板，作为兜底（用户想快速粘贴时可以直接用）。
      toast.remove();
      await copyToClipboard(cleaned); // 预填剪贴板，用户直接 Cmd+V 也能用
      showPreview(cleaned);
    } catch (err) {
      console.error("[web-ocr-copy]", err);
      updateToast(toast, "识别失败：" + (err.message || err), "error");
      setTimeout(() => toast.remove(), 3000);
    } finally {
      isBusy = false;
    }
  }

  // ================= 文本后处理 =================
  //
  // Tesseract 识别中文时常见问题：
  //   1) 汉字之间被硬塞空格："今 天 天 气 不 错"
  //   2) 中英文/中数字之间的空格被误加或误删
  //   3) 每行末尾多余的空白
  // 这里做保守清理，只处理明确的场景，避免误伤合法空格。

  function cleanOcrText(raw) {
    let t = raw;
    // 1) 汉字 ↔ 汉字之间的单个空格 → 删除
    //    使用 Unicode 汉字范围 [\u4e00-\u9fff]
    //    需要多跑几次，因为一次替换只能消除相邻的一对
    const CJK = "[\\u4e00-\\u9fff]";
    const reCjkSpace = new RegExp(`(${CJK})\\s+(?=${CJK})`, "g");
    let prev;
    do {
      prev = t;
      t = t.replace(reCjkSpace, "$1");
    } while (t !== prev);

    // 2) 汉字与英文/数字之间保留一个空格（更美观），先归一化
    t = t.replace(new RegExp(`(${CJK})\\s*([A-Za-z0-9])`, "g"), "$1 $2");
    t = t.replace(new RegExp(`([A-Za-z0-9])\\s*(${CJK})`, "g"), "$1 $2");

    // 3) 中文标点前后不应该有空格
    t = t.replace(/\s*([，。！？；：、"'"'（）《》【】])\s*/g, "$1");

    // 4) 每行 trim
    t = t.split("\n").map((s) => s.replace(/\s+$/g, "")).join("\n");

    // 5) 连续 3+ 空行压成 2 行
    t = t.replace(/\n{3,}/g, "\n\n");

    return t.trim();
  }

  // ================= 图像预处理 =================
  //
  // 目标：把彩色截图 → 高对比度的黑字白底二值图，Tesseract 对这种输入最友好。
  // 步骤：灰度化 → 用 Otsu 大津法自动求阈值 → 二值化。
  // 对深色主题网页也友好（黑底白字会自动反相）。

  function preprocessForOcr(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;

    // 1) 灰度化，同时统计直方图
    const gray = new Uint8ClampedArray(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      // Rec. 601 luma
      const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
      gray[j] = g;
      hist[g]++;
    }

    // 2) Otsu 求全局阈值
    const total = w * h;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, wF = 0, mB, mF, max = 0, threshold = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      mB = sumB / wB;
      mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > max) { max = between; threshold = t; }
    }

    // 3) 判断是否需要反相（深色主题：文字比背景亮，字数少）
    // 统计阈值以上/以下的像素数，字通常是少数派
    let above = 0;
    for (let k = 0; k < gray.length; k++) if (gray[k] > threshold) above++;
    const invert = above > gray.length / 2 ? false : true;
    // above > half：亮像素多 → 背景亮、字暗 → 不用反相
    // above < half：亮像素少 → 背景暗、字亮 → 反相

    // 4) 二值化写回
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      let isForeground = gray[j] < threshold; // 默认：字比背景暗
      if (invert) isForeground = !isForeground;
      const v = isForeground ? 0 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // ================= Tesseract 封装 =================
  //
  // 关键点：tesseract.min.js 已通过 manifest.content_scripts 静态注入，
  // 因此在 content script 的 isolated world 里可以直接拿到 Tesseract（UMD 会同时挂到 self / window / globalThis）。
  // 不要用 <script src> 动态注入 —— 那会挂到页面主世界 (main world)，content script 拿不到。

  let ocrWorkerPromise = null;

  function getTesseract() {
    // UMD 挂载点在不同浏览器/沙箱下不完全一致，逐个探测更稳。
    // 特别是 Chrome content script isolated world：如果 shim 失效、UMD 走了 CommonJS 分支，
    // Tesseract 会被挂到 module.exports 上而不是全局，这里做兜底探测。
    const candidates = [
      typeof Tesseract !== "undefined" ? Tesseract : null,
      typeof globalThis !== "undefined" ? globalThis.Tesseract : null,
      typeof self !== "undefined" ? self.Tesseract : null,
      typeof window !== "undefined" ? window.Tesseract : null,
      typeof globalThis !== "undefined" && globalThis.module && globalThis.module.exports ? globalThis.module.exports : null,
      typeof globalThis !== "undefined" ? globalThis.exports : null
    ];
    for (const c of candidates) {
      if (c && typeof c.createWorker === "function") return c;
      // 有些打包会把库塞到 default 字段
      if (c && c.default && typeof c.default.createWorker === "function") return c.default;
    }
    return null;
  }

  function getWorker() {
    if (ocrWorkerPromise) return ocrWorkerPromise;
    ocrWorkerPromise = (async () => {
      const T = getTesseract();
      if (!T || typeof T.createWorker !== "function") {
        throw new Error(
          "Tesseract 未加载，请重新加载扩展（manifest 已把 tesseract.min.js 加入 content_scripts）"
        );
      }
      const workerPath = chrome.runtime.getURL("lib/worker.min.js");
      const corePath = chrome.runtime.getURL("lib/tesseract-core.wasm.js");
      const langPath = chrome.runtime.getURL("lib/");

      const worker = await T.createWorker("chi_sim+eng", 1, {
        workerPath,
        corePath,
        langPath,
        cacheMethod: "none",
        logger: () => {}
      });

      // 关键参数优化：
      // - PSM 6：把整块图当作一个统一的文本段落（比默认的 auto 3 更准，尤其是短段落）
      // - preserve_interword_spaces：保留词间空格（中英混排时对英文单词分隔有用）
      // - user_defined_dpi=300：告诉引擎图像是高 DPI 的（我们截图 scale=3 相当于 3x 96 ≈ 288，取整 300）
      // - 关掉 Tesseract 对每个字符做单独识别的双 pass，改用单 pass（中文更快更稳）
      await worker.setParameters({
        tessedit_pageseg_mode: "6",
        preserve_interword_spaces: "1",
        user_defined_dpi: "300"
      });

      return worker;
    })().catch((err) => {
      // 一次失败后允许下次重试
      ocrWorkerPromise = null;
      throw err;
    });
    return ocrWorkerPromise;
  }

  async function runOcr(canvas) {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    return data.text;
  }

  // ================= UI 小组件 =================

  function showToast(text, kind = "ok", autoHideMs = 2000) {
    let el = document.getElementById("__web_ocr_toast__");
    if (!el) {
      el = document.createElement("div");
      el.id = "__web_ocr_toast__";
      el.innerHTML = '<span class="dot"></span><span class="msg"></span>';
      document.documentElement.appendChild(el);
    }
    updateToast(el, text, kind);
    if (autoHideMs > 0) setTimeout(() => el.remove(), autoHideMs);
    return el;
  }

  function updateToast(el, text, kind) {
    el.className = kind === "loading" ? "loading" : kind === "error" ? "error" : "";
    el.querySelector(".msg").textContent = text;
  }

  function showPreview(text) {
    const originalText = text; // 保留原文用于"恢复"

    const wrap = document.createElement("div");
    wrap.id = "__web_ocr_preview__";
    wrap.innerHTML = `
      <div class="header">
        <span>OCR 识别结果（可编辑）</span>
        <button class="close" title="关闭">✕</button>
      </div>
      <div class="toolbar">
        <button data-act="trim-spaces" title="选中文本则只处理选区，否则处理全文；删除所有空格（保留换行）">去空格</button>
        <button data-act="trim-newlines" title="选中文本则只处理选区，否则处理全文；把换行合并成一行">去换行</button>
        <button data-act="trim-punct" title="选中文本则只处理选区，否则处理全文；删除中英文标点">去标点</button>
        <button data-act="to-fullwidth" title="选中文本则只处理选区，否则处理全文；把半角标点/空格转为全角（中文标点）">半→全</button>
        <span class="sep"></span>
        <button data-act="undo" title="撤销上一步">↶ 撤销</button>
        <button data-act="reset" title="恢复到刚识别时的原文">恢复原文</button>
        <span class="counter"></span>
      </div>
      <textarea spellcheck="false"></textarea>
      <div class="footer">
        <span class="hint">选中部分文字可只处理选区 · 编辑后请点"复制"覆盖</span>
        <button class="cancel">关闭</button>
        <button class="primary copy">复制</button>
      </div>
    `;
    document.documentElement.appendChild(wrap);
    const ta = wrap.querySelector("textarea");
    const counter = wrap.querySelector(".counter");
    ta.value = text;
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);

    // 撤销栈：每次点工具栏按钮前把当前值 push 进去
    const undoStack = [];
    const MAX_UNDO = 20;

    const updateCounter = () => {
      const s = ta.value;
      const noWs = s.replace(/\s/g, "").length;
      const lines = s === "" ? 0 : s.split("\n").length;
      const selLen = ta.selectionEnd - ta.selectionStart;
      const base = `${s.length} 字 · 非空 ${noWs} · ${lines} 行`;
      counter.textContent = selLen > 0 ? `${base} · 选中 ${selLen}` : base;
      // 选中时高亮 counter，视觉提示"下次点按钮会只处理选区"
      counter.classList.toggle("has-selection", selLen > 0);
    };
    updateCounter();
    ta.addEventListener("input", updateCounter);
    // 选区变化时也要刷新（点击、拖选、键盘选择）
    ta.addEventListener("select", updateCounter);
    ta.addEventListener("keyup", updateCounter);
    ta.addEventListener("mouseup", updateCounter);

    // 撤销快照：不仅要存文本，还要存当时的光标位置和滚动位置。
    // 否则 textarea 每次赋新值后光标默认跳到末尾、视图也滚到末尾，
    // 用户就看不出"撤销回到了哪一步、变化了什么"。
    const pushUndo = () => {
      undoStack.push({
        value: ta.value,
        selStart: ta.selectionStart,
        selEnd: ta.selectionEnd,
        scrollTop: ta.scrollTop,
      });
      if (undoStack.length > MAX_UNDO) undoStack.shift();
    };

    // 支持"部分选中"：如果 textarea 里有非空选区，只对选区应用；否则对全文应用。
    // 处理完后光标停在被替换文本的末尾，方便继续操作。
    const applyTransform = (fn) => {
      pushUndo();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const hasSelection = start !== end;
      if (hasSelection) {
        const before = ta.value.slice(0, start);
        const selected = ta.value.slice(start, end);
        const after = ta.value.slice(end);
        const replaced = fn(selected);
        ta.value = before + replaced + after;
        // 让选区仍然覆盖处理后的文本，方便连续处理（去空格→再去标点）
        const newEnd = start + replaced.length;
        ta.setSelectionRange(start, newEnd);
      } else {
        ta.value = fn(ta.value);
      }
      updateCounter();
      ta.focus();
    };

    // ------- 三个一键处理 -------
    //
    // 「去空格」：删除所有类型的水平空白（半角空格、全角空格 \u3000、tab），保留换行。
    //             这是最常用的清理——OCR 中文/表格常会插入多余空格。
    //
    // 「去换行」：把所有换行合并成一行。做法：先把每行首尾空白 trim，再用空格拼接。
    //             如果只是"去掉换行但拼接时不加空格"，中英文混排会挤在一起，观感差。
    //             这里的策略：中文-中文 之间不加空格，其他情况加一个空格。
    //
    // 「去标点」：删除所有中英文标点符号，包括常见的成对括号、引号、破折号、省略号等。
    //             不动字母数字和文字本身。

    const removeAllSpaces = (s) =>
      s.replace(/[ \t\u00a0\u3000\f\v]/g, ""); // 保留 \n \r

    const removeAllNewlines = (s) => {
      // 先按行 trim，再智能拼接
      const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
      let out = "";
      for (let i = 0; i < lines.length; i++) {
        if (i === 0) { out = lines[i]; continue; }
        const prevEnd = out.charAt(out.length - 1);
        const nextStart = lines[i].charAt(0);
        const isCjk = (ch) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch);
        // 中文接中文：不加空格；否则加一个空格
        if (isCjk(prevEnd) && isCjk(nextStart)) {
          out += lines[i];
        } else {
          out += " " + lines[i];
        }
      }
      return out;
    };

    // 「半→全」：只转换标点符号和空格，保留 ASCII 字母数字不动
    //           针对 ASCII 引号做智能配对：奇数次遇到 " → “，偶数次 → ”；' 同理
    const toFullWidth = (s) => {
      // 简单一对一映射的标点
      const map = {
        ",": "，", ".": "。", "!": "！", "?": "？",
        ":": "：", ";": "；",
        "(": "（", ")": "）",
        "[": "【", "]": "】",
        "<": "《", ">": "》",
        "\\": "、",
        "~": "～", "$": "￥",
        " ": "\u3000" // 半角空格 → 全角空格
      };
      let dq = 0, sq = 0; // 引号配对计数
      let out = "";
      for (const ch of s) {
        if (ch === '"') { out += (dq++ % 2 === 0) ? "“" : "”"; continue; }
        if (ch === "'") { out += (sq++ % 2 === 0) ? "‘" : "’"; continue; }
        out += (ch in map) ? map[ch] : ch;
      }
      return out;
    };

    const removeAllPunctuation = (s) => {
      // 中文标点（GB/T + 常见）
      const cjkPunct = /[，。！？；：、""''「」『』（）《》〈〉【】〔〕—…·—～￥“”‘’]/g;
      // 英文/通用标点（ASCII 33-47 / 58-64 / 91-96 / 123-126 里的标点子集）
      const asciiPunct = /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]/g;
      return s.replace(cjkPunct, "").replace(asciiPunct, "");
    };

    wrap.querySelector('[data-act="trim-spaces"]').onclick = () => applyTransform(removeAllSpaces);
    wrap.querySelector('[data-act="trim-newlines"]').onclick = () => applyTransform(removeAllNewlines);
    wrap.querySelector('[data-act="trim-punct"]').onclick = () => applyTransform(removeAllPunctuation);
    wrap.querySelector('[data-act="to-fullwidth"]').onclick = () => applyTransform(toFullWidth);

    wrap.querySelector('[data-act="undo"]').onclick = () => {
      if (undoStack.length === 0) return;
      const snap = undoStack.pop();
      ta.value = snap.value;
      updateCounter();
      ta.focus();
      // 关键：恢复上一步的选区 + 滚动位置，让用户视觉上停在那次编辑的地方，
      // 一眼就能对比"撤销前 vs 撤销后"的差异。
      // 注意顺序：先 setSelectionRange，再 scrollTop —— setSelectionRange
      // 有时会自动把选区滚进视口，先设它可能覆盖 scrollTop，所以我们最后再写一次 scrollTop。
      try {
        ta.setSelectionRange(snap.selStart, snap.selEnd);
      } catch (_) { /* 边界情况忽略 */ }
      ta.scrollTop = snap.scrollTop;
    };
    wrap.querySelector('[data-act="reset"]').onclick = () => {
      pushUndo();
      ta.value = originalText;
      updateCounter();
      ta.focus();
    };

    const close = () => {
      document.removeEventListener("keydown", onKey);
      wrap.remove();
    };
    wrap.querySelector(".close").onclick = close;
    wrap.querySelector(".cancel").onclick = close;
    wrap.querySelector(".copy").onclick = async () => {
      await copyToClipboard(ta.value);
      close();
      showToast(`已复制 ${ta.value.length} 个字符`, "ok", 1800);
    };

    // 快捷键：Esc 关闭 / Cmd+Enter 复制 / Cmd+Z 撤销（用系统原生的行为，不劫持）
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        wrap.querySelector(".copy").click();
      }
    };
    document.addEventListener("keydown", onKey);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // 兜底：某些页面 clipboard API 被禁用
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }
})();
