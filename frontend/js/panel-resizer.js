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

    // 窗口大小变化时，如果保存的像素值与当前可用宽度不匹配，重置为 fr 单位
    var lastLayoutWidth = layout.getBoundingClientRect().width;
    window.addEventListener("resize", function () {
      var currentWidth = layout.getBoundingClientRect().width;
      // 宽度变化超过 50px 时检查
      if (Math.abs(currentWidth - lastLayoutWidth) < 50) return;
      lastLayoutWidth = currentWidth;

      var col1 = layout.style.getPropertyValue("--col1");
      var col2 = layout.style.getPropertyValue("--col2");
      // 只有保存的是像素值时才需要处理
      if (col1 && col1.includes("px") && col2 && col2.includes("px")) {
        var col1px = parseInt(col1);
        var col2px = parseInt(col2);
        var resizerW = 6;
        var totalPx = col1px + col2px + resizerW;
        // 如果保存的总宽度与当前宽度差异超过 15%，重置为默认 fr 比例
        if (Math.abs(totalPx - currentWidth) / currentWidth > 0.15) {
          layout.style.removeProperty("--col1");
          layout.style.removeProperty("--col2");
          saveSizes();
        }
      }

      // 行高同理
      var row1 = layout.style.getPropertyValue("--row1");
      var row2 = layout.style.getPropertyValue("--row2");
      if (row1 && row1.includes("px") && row2 && row2.includes("px")) {
        var row1px = parseInt(row1);
        var row2px = parseInt(row2);
        var resizerH = 6;
        var totalRowPx = row1px + row2px + resizerH;
        var currentHeight = layout.getBoundingClientRect().height;
        if (Math.abs(totalRowPx - currentHeight) / currentHeight > 0.15) {
          layout.style.removeProperty("--row1");
          layout.style.removeProperty("--row2");
          saveSizes();
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPanelResizers);
  } else {
    initPanelResizers();
  }
})();
