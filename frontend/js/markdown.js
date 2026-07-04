// ========== Markdown / LaTeX 渲染 ==========
var MATH_PH = "\u0000MATH\u0000";

function _protectMath(src, blocks) {
  const pats = [
    /\$\$[\s\S]+?\$\$/g,
    /\\\[[\s\S]+?\\\]/g,
    /\$[^\$\n]+?\$/g,
    /\\\([^\\\n]+?\\\)/g,
  ];
  let out = src;
  let id = 0;
  for (const re of pats) {
    out = out.replace(re, (m) => {
      const ph = `${MATH_PH}${id}${MATH_PH}`;
      blocks[id] = m;
      id++;
      return ph;
    });
  }
  return out;
}

function _restoreMath(html, blocks) {
  for (let i = 0; i < blocks.length; i++) {
    const ph = `${MATH_PH}${i}${MATH_PH}`;
    html = html.split(ph).join(blocks[i]);
  }
  return html;
}

function renderMarkdown(src, opts = {}) {
  if (!src) return "";
  const escape = opts.escape !== false;
  let text = src;
  if (escape) text = escapeHtml(text);
  if (window.marked) {
    try {
      const blocks = [];
      const protected_text = _protectMath(text, blocks);
      let html = marked.parse(protected_text);
      if (blocks.length) html = _restoreMath(html, blocks);
      return html;
    } catch (e) {
      console.warn("Markdown parse error:", e);
    }
  }
  return escapeHtml(src).replace(/\n/g, "<br>");
}

function renderMathInMsg(el) {
  if (window.renderMathInElement) {
    renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      throwOnError: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
    });
  }
}

function initMarked() {
  if (!window.marked) return;
  marked.setOptions({ breaks: true, gfm: true });
}
