// ========== 图片上传 ==========
var elUploadInput = $("#upload-input");
var elUploadInputProblem = $("#upload-input-problem");
var elUploadPreview = $("#upload-preview");
var elUploadThumb = $("#upload-thumb");
var pendingUpload = null; // { dataUrl, mediaType, base64, mode: 'answer' | 'problem' }

async function fileToImageBlob(file, maxSize = 1280) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = dataUrl;
  });
  let { width, height } = img;
  if (width > maxSize || height > maxSize) {
    const r = Math.min(maxSize / width, maxSize / height);
    width = Math.round(width * r);
    height = Math.round(height * r);
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d").drawImage(img, 0, 0, width, height);
  const outUrl = c.toDataURL("image/jpeg", 0.85);
  const [meta, b64] = outUrl.split(",");
  const mediaType = (meta.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
  return { dataUrl: outUrl, mediaType, base64: b64 };
}

async function handleUploadFile(file, mode) {
  try {
    const blob = await fileToImageBlob(file);
    pendingUpload = { ...blob, mode };
    elUploadThumb.src = pendingUpload.dataUrl;
    const send = $("#upload-send");
    send.textContent =
      mode === "problem" ? "识别为新题（会弹窗确认）" : "发给 AI 检查";
    elUploadPreview.hidden = false;
  } catch (err) {
    addErrorMsg("图片处理失败: " + err.message);
  }
}

async function autoRecognizeProblemImage(file) {
  try {
    const blob = await fileToImageBlob(file);
    const prompt =
      "这是一道题目的图片。请仔细识别图片里的题面（有公式就用 LaTeX $...$ 表示），判断主题类型，给出正确答案和 2-3 条递进提示，然后调用 propose_problem 工具向我提议这道新题。" +
      '注意：你不必自己切换题目；propose_problem 会弹窗让我确认是否替换当前题。如果原图含有题目相关图形，务必设 figure: {type:"image"}。';
    addUserMsg("（拖拽上传题目图片，请识别为新题）", blob.dataUrl);
    runTurn(prompt, {
      image: { mediaType: blob.mediaType, data: blob.base64 },
    });
  } catch (err) {
    addErrorMsg("图片处理失败: " + err.message);
  }
}

// ---------- 文件选择 ----------
elUploadInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) await handleUploadFile(file, "answer");
  elUploadInput.value = "";
});
elUploadInputProblem.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) await autoRecognizeProblemImage(file);
  elUploadInputProblem.value = "";
});

// ---------- 拖拽上传 ----------
// 做题区面板 -> 默认解答；题目区面板 -> 默认题目；聊天区面板 -> 默认解答
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
    if (mode === "problem") {
      await autoRecognizeProblemImage(file);
    } else {
      await handleUploadFile(file, mode);
    }
  });
}

setupDropZone($(".panel-work"), "answer", "我的解答（按住 Shift 改为题目）");
setupDropZone(
  $(".panel-problem"),
  "problem",
  "题目图片（按住 Shift 改为解答）",
);
setupDropZone($(".panel-ai"), "answer", "我的解答（按住 Shift 改为题目）");

// ---------- 粘贴图片上传 ----------
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
      if (inProblemPanel && !inChatInput) {
        await autoRecognizeProblemImage(file);
      } else {
        await handleUploadFile(file, "answer");
      }
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
  let prompt;
  if (pendingUpload.mode === "problem") {
    prompt =
      caption ||
      "这是一道题目的图片。请仔细识别图片里的题面（有公式就用 LaTeX $...$ 表示），判断主题类型，给出正确答案和 2-3 条递进提示，然后调用 propose_problem 工具向我提议这道新题。" +
        "注意：你不必自己切换题目；propose_problem 会弹窗让我确认是否替换当前题。";
    addUserMsg(
      caption || "（上传了一张题目图片，请识别为新题）",
      pendingUpload.dataUrl,
    );
  } else {
    prompt =
      caption ||
      "这是我写在纸上的做题过程 / 答案，请帮我看看对不对、有没有需要改进的地方。";
    addUserMsg(caption || prompt, pendingUpload.dataUrl);
  }
  elChatInput.value = "";
  runTurn(prompt, {
    image: { mediaType: pendingUpload.mediaType, data: pendingUpload.base64 },
  });
  pendingUpload = null;
  elUploadPreview.hidden = true;
});
