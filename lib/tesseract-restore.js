/**
 * 配合 tesseract-shim.js：tesseract.min.js 加载完毕后，
 * 恢复原始的 module/exports/define，避免影响页面其他脚本或 content.js 自身。
 */
(() => {
  const g = globalThis;
  const s = g.__ocrShim__;
  if (!s) return;
  if (s.module === undefined) { try { delete g.module; } catch (_) {} } else { g.module = s.module; }
  if (s.exports === undefined) { try { delete g.exports; } catch (_) {} } else { g.exports = s.exports; }
  if (s.define === undefined) { try { delete g.define; } catch (_) {} } else { g.define = s.define; }
  try { delete g.__ocrShim__; } catch (_) {}
})();
