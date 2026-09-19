// ========== 图片上传（题目 / 解答）==========
//
// 两条链路刻意不同：
//   题目：拍照/选图 → **裁剪** → 直接送 AI 识别（裁剪本身就是确认步骤，不再多一次点击）
//   解答：拍照/选图 → 预览 → 用户点「发给 AI 检查」（纸面解答往往整页都要看，不裁）
//
// 另外「拍照」与「相册」必须是两个入口：带 capture 的 input 在 iOS/Android 上会
// **直接打开相机、不给选已有照片的机会**，而孩子经常需要上传老师发来的题目截图。
var PROBLEM_RECOGNIZE_PROMPT =
  "这是一道题目的图片。请仔细识别图片里的题面（有公式就用 LaTeX $...$ 表示），判断主题类型，然后调用 propose_problem 工具向我提议这道新题。" +
  '注意：你只需识别题目并出题，不要在对话里解答题目或给出答案/解题步骤；答案和提示作为 propose_problem 的参数提交即可（不会在对话里展示）。你不必自己切换题目；propose_problem 会弹窗让我确认是否替换当前题。如果原图含有题目相关图形，务必设 figure: {type:"image"}。';

var elUploadPreview = $("#upload-preview");
var elUploadThumb = $("#upload-thumb");
var pendingUpload = null; // { dataUrl, mediaType, base64, mode }

var ANSWER_MAX_EDGE = 1280; // 纸面解答不需要太高分辨率

function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

// 等比缩放到长边不超过 maxEdge，统一输出 JPEG。返回 dataURL。
async function downscaleDataUrl(srcDataUrl, maxEdge) {
  const img = await loadImgEl(srcDataUrl);
  let { naturalWidth: w, naturalHeight: h } = img;
  if (w > maxEdge || h > maxEdge) {
    const r = Math.min(maxEdge / w, maxEdge / h);
    w = Math.round(w * r);
    h = Math.round(h * r);
  }
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const cx = c.getContext("2d");
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = "high";
  cx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.9);
}

// 统一入口：任何来源（拍照 / 相册 / 拖入 / 粘贴）的图片都走这里
async function ingestImageFile(file, mode) {
  if (!file) return;
  try {
    const raw = await fileToDataUrl(file);

    if (mode === "problem") {
      // 先裁剪：把「本题」框出来再送识别，避免整页混进邻题
      const cropped = await openCropDialog(raw);
      if (!cropped) return; // 用户取消
      const parts = dataUrlToParts(cropped);
      addUserMsg("（上传题目图片，请识别为新题）", parts.dataUrl);
      runTurn(PROBLEM_RECOGNIZE_PROMPT, {
        image: { mediaType: parts.mediaType, data: parts.base64 },
      });
      return;
    }

    // 解答：缩放后进预览，等用户确认再发
    const small = await downscaleDataUrl(raw, ANSWER_MAX_EDGE);
    pendingUpload = { ...dataUrlToParts(small), mode: "answer" };
    elUploadThumb.src = pendingUpload.dataUrl;
    $("#upload-send").textContent = "发给 AI 检查";
    elUploadPreview.hidden = false;
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/heic|heif/i.test(msg) || /decode|解码/i.test(msg)) {
      addErrorMsg(
        "这张图读不出来。iPhone 默认存的是 HEIC 格式，请在 设置 → 相机 → 格式 里改成「兼容性最佳」，或在相册里先截图再上传。",
      );
    } else {
      addErrorMsg("图片处理失败: " + msg);
    }
  }
}

// ---------- 文件选择（拍照 / 相册 各一个 input）----------
[
  ["#upload-problem-camera", "problem"],
  ["#upload-problem-album", "problem"],
  ["#upload-answer-camera", "answer"],
  ["#upload-answer-album", "answer"],
].forEach(([sel, mode]) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    // 先清空 value，保证「同一张图连拍两次」也能再次触发 change
    e.target.value = "";
    if (file) await ingestImageFile(file, mode);
  });
});

// ---------- 拖拽上传（桌面）----------
function setupDropZone(el, defaultMode, label) {
  if (!el) return;
  let depth = 0;
  const isImage = (f) => f && f.type && f.type.startsWith("image/");
  const overlay = document.createElement("div");
  overlay.className = "drop-overlay";
  overlay.textContent = `松开鼠标：作为「${label}」上传`;
  el.appendChild(overlay);
  el.classList.add("drop-host");

  el.addEventListener("dragenter", (e) => {
    if (
      !e.dataTransfer ||
      !Array.from(e.dataTransfer.items || []).some((i) => i.kind === "file")
    )
      return;
    e.preventDefault();
    depth++;
    el.classList.add("drag-over");
  });
  el.addEventListener("dragover", (e) => {
    if (Array.from(e.dataTransfer.items || []).some((i) => i.kind === "file")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  el.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove("drag-over");
  });
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    el.classList.remove("drag-over");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!isImage(file)) {
      addSystemMsg("⚠️ 请拖入图片文件");
      return;
    }
    const useAlt = e.shiftKey;
    let mode = defaultMode;
    if (useAlt) mode = defaultMode === "answer" ? "problem" : "answer";
    await ingestImageFile(file, mode);
  });
}

setupDropZone($(".panel-work"), "answer", "我的解答（按住 Shift 改为题目）");
setupDropZone(
  $(".panel-problem"),
  "problem",
  "题目图片（按住 Shift 改为解答）",
);
setupDropZone($(".panel-ai"), "answer", "我的解答（按住 Shift 改为题目）");

// ---------- 粘贴图片上传（桌面）----------
document.addEventListener("paste", async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const activeEl = document.activeElement;
      const inProblemPanel = activeEl && $(".panel-problem").contains(activeEl);
      const inChatInput = activeEl === elChatInput;
      await ingestImageFile(file, inProblemPanel && !inChatInput ? "problem" : "answer");
      break;
    }
  }
});

// ---------- 上传预览操作 ----------
$("#upload-cancel").addEventListener("click", () => {
  pendingUpload = null;
  elUploadPreview.hidden = true;
});

$("#upload-send").addEventListener("click", () => {
  if (!pendingUpload) return;
  const caption = elChatInput.value.trim();
  const prompt =
    caption ||
    "这是我写在纸上的做题过程 / 答案，请帮我看看对不对、有没有需要改进的地方。";
  addUserMsg(caption || prompt, pendingUpload.dataUrl);
  elChatInput.value = "";
  runTurn(prompt, {
    image: { mediaType: pendingUpload.mediaType, data: pendingUpload.base64 },
  });
  pendingUpload = null;
  elUploadPreview.hidden = true;
});
