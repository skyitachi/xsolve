// ========== 拍照 / 选图后的裁剪 ==========
//
// 为什么需要它：手机对着作业本拍一张，画面里通常有整页甚至两三道题。
// 直接整张丢给 AI，识别出来的题面经常串题、混入邻题、或把无关文字当题干。
// 先框出「本题」再送，识别质量差别很大。
//
// 实现要点：
//  - 用 Pointer Events 一套代码同时吃触屏与鼠标（不必写 touch/mouse 两套）。
//  - 选择框支持整体拖动 + 四角缩放，全部钳制在图片范围内。
//  - 输出按**原图分辨率**裁剪（不是屏幕上缩小的那份），长边上限 1600 —— 比原来
//    的 1280 更利于识别作业本上的小字。
//  - 样式内联注入，不去改 styles.css，避免和主样式表互相影响。

var CROP_MAX_EDGE = 1600; // 送 AI 的图片长边上限
var CROP_MIN_BOX = 44; // 选择框最小边长（屏幕像素）

var CROP_CSS = `
.crop-root{position:fixed;inset:0;z-index:3000;background:rgba(17,24,39,.94);
  display:flex;flex-direction:column;padding:env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,0) env(safe-area-inset-left,0);}
.crop-head{padding:10px 14px;color:#f9fafb;font-size:14px;font-weight:600;text-align:center;}
.crop-head .crop-sub{display:block;font-weight:400;font-size:12px;color:#9ca3af;margin-top:2px;}
.crop-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 10px;overflow:hidden;}
.crop-stage canvas{max-width:100%;max-height:100%;touch-action:none;display:block;
  border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.5);cursor:crosshair;}
.crop-foot{display:flex;gap:8px;padding:12px 14px calc(12px + env(safe-area-inset-bottom,0));}
.crop-foot button{flex:1;padding:12px 8px;border-radius:10px;border:1px solid #374151;
  background:#1f2937;color:#e5e7eb;font-size:14px;cursor:pointer;font-weight:500;touch-action:manipulation;}
.crop-foot button:active{background:#374151;}
.crop-foot .crop-primary{background:#4f46e5;border-color:#4f46e5;color:#fff;}
.crop-foot .crop-primary:active{background:#4338ca;}
`;

function cropInjectStyle() {
  if (document.getElementById("crop-style")) return;
  const s = document.createElement("style");
  s.id = "crop-style";
  s.textContent = CROP_CSS;
  document.head.appendChild(s);
}

function loadImgEl(dataUrl) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("图片解码失败"));
    im.src = dataUrl;
  });
}

// 打开裁剪界面。resolve 出裁剪后的 dataURL；用户取消则 resolve(null)。
function openCropDialog(srcDataUrl) {
  cropInjectStyle();
  return loadImgEl(srcDataUrl).then(
    (img) =>
      new Promise((resolve) => {
        const root = document.createElement("div");
        root.className = "crop-root";
        root.innerHTML =
          '<div class="crop-head">框出这一道题' +
          '<span class="crop-sub">拖动方框可移动，拖四角可缩放；整页就点「用全图」</span></div>' +
          '<div class="crop-stage"><canvas></canvas></div>' +
          '<div class="crop-foot">' +
          '<button type="button" data-act="cancel">取消</button>' +
          '<button type="button" data-act="all">用全图</button>' +
          '<button type="button" class="crop-primary" data-act="ok">确认裁剪</button>' +
          "</div>";
        document.body.appendChild(root);

        const stage = root.querySelector(".crop-stage");
        const canvas = root.querySelector("canvas");
        const octx = canvas.getContext("2d");

        let dispW = 0;
        let dispH = 0;
        let sel = { x: 0, y: 0, w: 0, h: 0 };
        let drag = null; // { mode, startX, startY, box }

        // 让画布恰好铺满可用区域内的等比缩放图
        function layout() {
          // clientWidth/Height 含 padding，必须减掉，否则算出的显示尺寸偏大，
          // 而 CSS 的 max-width:100% 又会把它压回去 —— 两者不一致会让
          // 「屏幕坐标 → 原图坐标」的换算整体偏掉，裁出来的范围就不是用户框的那个。
          const cs = getComputedStyle(stage);
          const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
          const scale = Math.min(aw / img.naturalWidth, ah / img.naturalHeight, 1);
          dispW = Math.max(1, Math.round(img.naturalWidth * scale));
          dispH = Math.max(1, Math.round(img.naturalHeight * scale));
          const dpr = window.devicePixelRatio || 1;
          canvas.style.width = dispW + "px";
          canvas.style.height = dispH + "px";
          canvas.width = Math.round(dispW * dpr);
          canvas.height = Math.round(dispH * dpr);
          octx.setTransform(dpr, 0, 0, dpr, 0, 0);
          // 首次进入时默认框住中间 88%，留出可见的边距提示「可以拖」
          if (!sel.w || sel.w < 1) {
            const inset = 0.06;
            sel = {
              x: dispW * inset,
              y: dispH * inset,
              w: dispW * (1 - inset * 2),
              h: dispH * (1 - inset * 2),
            };
          } else {
            sel = clampBox(sel);
          }
          paint();
        }

        function clampBox(b) {
          let w = Math.min(Math.max(b.w, CROP_MIN_BOX), dispW);
          let h = Math.min(Math.max(b.h, CROP_MIN_BOX), dispH);
          let x = Math.min(Math.max(b.x, 0), dispW - w);
          let y = Math.min(Math.max(b.y, 0), dispH - h);
          return { x, y, w, h };
        }

        function paint() {
          octx.clearRect(0, 0, dispW, dispH);
          octx.drawImage(img, 0, 0, dispW, dispH);

          // 框外压暗：画四块，避免用合成模式带来的兼容问题
          octx.fillStyle = "rgba(17,24,39,.62)";
          octx.fillRect(0, 0, dispW, sel.y);
          octx.fillRect(0, sel.y + sel.h, dispW, dispH - sel.y - sel.h);
          octx.fillRect(0, sel.y, sel.x, sel.h);
          octx.fillRect(sel.x + sel.w, sel.y, dispW - sel.x - sel.w, sel.h);

          // 三分线
          octx.strokeStyle = "rgba(255,255,255,.35)";
          octx.lineWidth = 1;
          for (let i = 1; i <= 2; i++) {
            const gx = sel.x + (sel.w * i) / 3;
            const gy = sel.y + (sel.h * i) / 3;
            octx.beginPath();
            octx.moveTo(gx, sel.y);
            octx.lineTo(gx, sel.y + sel.h);
            octx.moveTo(sel.x, gy);
            octx.lineTo(sel.x + sel.w, gy);
            octx.stroke();
          }

          // 边框 + 四角手柄
          octx.strokeStyle = "#ffffff";
          octx.lineWidth = 2;
          octx.strokeRect(sel.x + 1, sel.y + 1, sel.w - 2, sel.h - 2);
          const HS = 18;
          octx.fillStyle = "#4f46e5";
          octx.strokeStyle = "#ffffff";
          octx.lineWidth = 2;
          cornerPoints().forEach((p) => {
            octx.beginPath();
            octx.fillRect(p.x - HS / 2, p.y - HS / 2, HS, HS);
            octx.strokeRect(p.x - HS / 2, p.y - HS / 2, HS, HS);
          });
        }

        function cornerPoints() {
          return [
            { k: "tl", x: sel.x, y: sel.y },
            { k: "tr", x: sel.x + sel.w, y: sel.y },
            { k: "bl", x: sel.x, y: sel.y + sel.h },
            { k: "br", x: sel.x + sel.w, y: sel.y + sel.h },
          ];
        }

        function localPoint(e) {
          const r = canvas.getBoundingClientRect();
          return { x: e.clientX - r.left, y: e.clientY - r.top };
        }

        const TOUCH_SLOP = 26; // 触屏手指没那么准，命中范围要放大

        function hitTest(p) {
          for (const c of cornerPoints()) {
            if (Math.abs(p.x - c.x) <= TOUCH_SLOP && Math.abs(p.y - c.y) <= TOUCH_SLOP) {
              return "resize-" + c.k;
            }
          }
          if (p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h) {
            return "move";
          }
          return null;
        }

        function onDown(e) {
          const p = localPoint(e);
          const mode = hitTest(p);
          if (!mode) return; // 框外拖动不改变选择，避免误触把它弄没
          e.preventDefault();
          canvas.setPointerCapture(e.pointerId);
          drag = { mode, startX: p.x, startY: p.y, box: { ...sel } };
        }

        function onMove(e) {
          if (!drag) {
            // 悬停时给个光标提示（鼠标场景）
            const p = localPoint(e);
            const m = hitTest(p);
            canvas.style.cursor = m
              ? m === "move"
                ? "move"
                : m === "resize-tl" || m === "resize-br"
                  ? "nwse-resize"
                  : "nesw-resize"
              : "crosshair";
            return;
          }
          e.preventDefault();
          const p = localPoint(e);
          const dx = p.x - drag.startX;
          const dy = p.y - drag.startY;
          const b = drag.box;
          if (drag.mode === "move") {
            sel = clampBox({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });
          } else {
            // 让对角的那个角保持不动
            let left = b.x;
            let top = b.y;
            let right = b.x + b.w;
            let bottom = b.y + b.h;
            if (drag.mode.endsWith("l")) left = Math.min(b.x + dx, right - CROP_MIN_BOX);
            if (drag.mode.endsWith("r")) right = Math.max(b.x + b.w + dx, left + CROP_MIN_BOX);
            if (drag.mode.endsWith("t")) top = Math.min(b.y + dy, bottom - CROP_MIN_BOX);
            if (drag.mode.endsWith("b")) bottom = Math.max(b.y + b.h + dy, top + CROP_MIN_BOX);
            left = Math.max(0, left);
            top = Math.max(0, top);
            right = Math.min(dispW, right);
            bottom = Math.min(dispH, bottom);
            sel = { x: left, y: top, w: right - left, h: bottom - top };
          }
          paint();
        }

        function onUp(e) {
          if (!drag) return;
          drag = null;
          try {
            canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }

        canvas.addEventListener("pointerdown", onDown);
        canvas.addEventListener("pointermove", onMove);
        canvas.addEventListener("pointerup", onUp);
        canvas.addEventListener("pointercancel", onUp);
        window.addEventListener("resize", layout);

        function cleanup(result) {
          window.removeEventListener("resize", layout);
          root.remove();
          resolve(result);
        }

        root.querySelector('[data-act="cancel"]').addEventListener("click", () => cleanup(null));
        root.querySelector('[data-act="all"]').addEventListener("click", () => {
          sel = { x: 0, y: 0, w: dispW, h: dispH };
          cleanup(encode());
        });
        root.querySelector('[data-act="ok"]').addEventListener("click", () => cleanup(encode()));

        function encode() {
          // 屏幕坐标 → 原图坐标
          const sx = (sel.x / dispW) * img.naturalWidth;
          const sy = (sel.y / dispH) * img.naturalHeight;
          const sw = (sel.w / dispW) * img.naturalWidth;
          const sh = (sel.h / dispH) * img.naturalHeight;
          const scale = Math.min(1, CROP_MAX_EDGE / Math.max(sw, sh));
          const out = document.createElement("canvas");
          out.width = Math.max(1, Math.round(sw * scale));
          out.height = Math.max(1, Math.round(sh * scale));
          const octx2 = out.getContext("2d");
          octx2.imageSmoothingEnabled = true;
          octx2.imageSmoothingQuality = "high";
          octx2.drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
          return out.toDataURL("image/jpeg", 0.92);
        }

        layout();
      }),
  );
}

// 把 dataURL 拆成后端需要的 { mediaType, base64 }
function dataUrlToParts(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  return {
    dataUrl,
    mediaType: (meta.match(/data:([^;]+)/) || [])[1] || "image/jpeg",
    base64: b64,
  };
}
