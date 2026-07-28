/**
 * Tesseract UMD shim for Chrome extension content scripts.
 *
 * 问题：Chrome content script 的 isolated world 里 globalThis 上可能存在 module/exports/define，
 *      导致 tesseract.min.js 的 UMD 探测走成 CommonJS/AMD 分支，Tesseract 就挂不到全局。
 *
 * 做法：在 tesseract.min.js 加载前先"藏起" module/exports/define，
 *      加载完成后由 tesseract.min.js 自身走全局分支挂上 self.Tesseract，
 *      随后我们再恢复。
 *
 * 注意：这个 shim 必须在 tesseract.min.js **之前** 被 content_scripts 加载。
 */
(() => {
  const g = globalThis;
  // 保存原始值（可能是 undefined）
  g.__ocrShim__ = {
    module: g.module,
    exports: g.exports,
    define: g.define
  };
  // 让 UMD 判断 "typeof module === 'undefined'"
  try { delete g.module; } catch (_) { g.module = undefined; }
  try { delete g.exports; } catch (_) { g.exports = undefined; }
  try { delete g.define; } catch (_) { g.define = undefined; }
})();
