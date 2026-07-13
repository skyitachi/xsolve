/**
 * 面板可拖拽调节大小（类似 Windows 窗口）
 * 支持两个方向的拖拽：
 * 1. 水平分割条（resizer-h）：上下拖拽，调节 problem/work 行高
 * 2. 垂直分割条（resizer-v）：左右拖拽，调节左列/ai 列宽
 */
(function () {
  function initPanelResizers() {
    var layout = document.getElementById("layout");
    if (!layout) return;

    var resizerRows = document.getElementById("resizer-rows");
    var resizerCols = document.getElementById("resizer-cols");
    if (!resizerRows && !resizerCols) return;

    // 从 localStorage 恢复上次尺寸
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem("panelSizes") || "{}"); } catch {}

    function applySaved() {
      if (saved.col1 && saved.col2) {
        layout.style.setProperty("--col1", saved.col1);
        layout.style.setProperty("--col2", saved.col2);
      }
      if (saved.row1 && saved.row2) {
        layout.style.setProperty("--row1", saved.row1);
        layout.style.setProperty("--row2", saved.row2);
      }
    }
    applySaved();

    function saveSizes() {
      try {
        localStorage.setItem("panelSizes", JSON.stringify({
          col1: layout.style.getPropertyValue("--col1") || "",
          col2: layout.style.getPropertyValue("--col2") || "",
          row1: layout.style.getPropertyValue("--row1") || "",
          row2: layout.style.getPropertyValue("--row2") || "",
        }));
      } catch {}
    }

    /**
     * 通用拖拽工厂
     * @param {HTMLElement} handle - 拖拽手柄元素
     * @param {string} dir - 'h' 水平分割（上下拖拽）| 'v' 垂直分割（左右拖拽）
     */
    function makeResizer(handle, dir) {
      handle.addEventListener("mousedown", start);
      handle.addEventListener("touchstart", start, { passive: false });

      function start(e) {
        e.preventDefault();
        e.stopPropagation();
        window._panelResizing = true;
        handle.classList.add("dragging");
        document.body.style.cursor = dir === "h" ? "row-resize" : "col-resize";
        document.body.style.userSelect = "none";

        var startX = e.touches ? e.touches[0].clientX : e.clientX;
        var startY = e.touches ? e.touches[0].clientY : e.clientY;

        // 记录拖拽前的布局尺寸
        var rect = layout.getBoundingClientRect();
        var panelA, panelB;

        if (dir === "h") {
          // 上下拖拽：调节 row1（problem）和 row2（work）
          panelA = document.querySelector(".panel-problem");
          panelB = document.querySelector(".panel-work");
        } else {
          // 左右拖拽：调节 col1（左列）和 col2（ai）
          panelA = document.querySelector(".panel-problem");
          panelB = document.querySelector(".panel-ai");
        }
        var startSizeA = dir === "h" ? panelA.offsetHeight : panelA.offsetWidth;
        var startSizeB = dir === "h" ? panelB.offsetHeight : panelB.offsetWidth;
        var totalSize = startSizeA + startSizeB;
        var minSize = 120;
        var maxSize = totalSize - minSize;

        function onMove(ev) {
          ev.preventDefault();
          var cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
          var cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
          var delta = dir === "h" ? (cy - startY) : (cx - startX);
          var newSizeA = Math.max(minSize, Math.min(maxSize, startSizeA + delta));
          var newSizeB = totalSize - newSizeA;

          if (dir === "h") {
            layout.style.setProperty("--row1", newSizeA + "px");
            layout.style.setProperty("--row2", newSizeB + "px");
          } else {
            layout.style.setProperty("--col1", newSizeA + "px");
            layout.style.setProperty("--col2", newSizeB + "px");
          }
        }

        function onEnd() {
          window._panelResizing = false;
          handle.classList.remove("dragging");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("touchmove", onMove);
          document.removeEventListener("mouseup", onEnd);
          document.removeEventListener("touchend", onEnd);
          saveSizes();
        }

        document.addEventListener("mousemove", onMove);
        document.addEventListener("touchmove", onMove, { passive: false });
        document.addEventListener("mouseup", onEnd);
        document.addEventListener("touchend", onEnd);
      }
    }

    if (resizerRows) makeResizer(resizerRows, "h");
    if (resizerCols) makeResizer(resizerCols, "v");

    // 窗口大小变化时，如果像素值超出范围，重置为 fr 单位
    window.addEventListener("resize", function () {
      // 只在宽度变化超过阈值时清除保存的像素值
      // 避免每次小变化都重置
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPanelResizers);
  } else {
    initPanelResizers();
  }
})();
