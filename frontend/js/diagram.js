// ========== 画图法/图形法 交互式 SVG 渲染引擎 ==========
// 将 AI 生成的 Diagram Spec JSON 渲染为带分步动画的交互式 SVG
// 支持: geometry (矩形/三角形/圆/线段/文字) 和 bar-model (条形模型)

var SVG_NS = 'http://www.w3.org/2000/svg';
var DIAGRAM_DEFAULTS = {
  width: 360,
  height: 280,
  padding: 20,
};

/**
 * 主入口：渲染一个 diagram
 * @param {object} spec - Diagram Spec JSON
 * @param {HTMLElement} container - 父容器
 */
function renderDiagram(spec, container) {
  // 计算画布尺寸：取 elements 的最大坐标
  var maxW = spec.width || DIAGRAM_DEFAULTS.width;
  var maxH = spec.height || DIAGRAM_DEFAULTS.height;
  for (var i = 0; i < spec.elements.length; i++) {
    var el = spec.elements[i];
    var elW = (el.x2 || el.x + (el.w || el.r * 2 || 0)) + 20;
    var elH = (el.y2 || el.y + (el.h || el.r * 2 || el.fontSize || 14)) + 20;
    if (elW > maxW) maxW = elW;
    if (elH > maxH) maxH = elH;
  }
  maxW = Math.max(maxW, 200);
  maxH = Math.max(maxH, 160);

  // 外层容器
  var wrapper = document.createElement('div');
  wrapper.className = 'diagram-wrapper';

  // 标题
  if (spec.title) {
    var title = document.createElement('div');
    title.className = 'diagram-title';
    title.textContent = spec.title;
    wrapper.appendChild(title);
  }

  // SVG 画布
  var svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + maxW + ' ' + maxH);
  svg.setAttribute('class', 'diagram-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  wrapper.appendChild(svg);

  // 渲染所有元素
  var elementMap = {}; // id -> svg element
  for (var j = 0; j < spec.elements.length; j++) {
    var elDef = spec.elements[j];
    var svgEl = renderDiagramElement(elDef, svg);
    if (svgEl) {
      if (elDef.id) elementMap[elDef.id] = svgEl;
      // 初始可见性
      if (elDef.visible === false) {
        svgEl.style.opacity = '0';
        svgEl.style.display = 'none';
      }
    }
  }

  // 步骤控制
  var currentStep = -1;
  var steps = spec.steps || [];
  if (steps.length > 0) {
    var stepsPanel = document.createElement('div');
    stepsPanel.className = 'diagram-steps';

    var stepTitle = document.createElement('div');
    stepTitle.className = 'diagram-step-title';
    stepsPanel.appendChild(stepTitle);

    var stepDesc = document.createElement('div');
    stepDesc.className = 'diagram-step-desc';
    stepsPanel.appendChild(stepDesc);

    var stepControls = document.createElement('div');
    stepControls.className = 'diagram-step-controls';

    var prevBtn = document.createElement('button');
    prevBtn.className = 'diagram-btn diagram-btn-prev';
    prevBtn.textContent = '上一步';
    prevBtn.disabled = true;

    var nextBtn = document.createElement('button');
    nextBtn.className = 'diagram-btn diagram-btn-next';
    nextBtn.textContent = '下一步';

    var progress = document.createElement('span');
    progress.className = 'diagram-progress';
    progress.textContent = '0 / ' + steps.length;

    stepControls.appendChild(prevBtn);
    stepControls.appendChild(progress);
    stepControls.appendChild(nextBtn);
    stepsPanel.appendChild(stepControls);
    wrapper.appendChild(stepsPanel);

    // 初始状态：隐藏所有带 id 的元素
    for (var key in elementMap) {
      elementMap[key].style.opacity = '0';
      elementMap[key].style.display = 'none';
    }

    function goToStep(idx) {
      if (idx < 0 || idx >= steps.length) return;
      currentStep = idx;
      var step = steps[idx];

      // 应用 show/hide
      if (step.show) {
        for (var s = 0; s < step.show.length; s++) {
          var showId = step.show[s];
          var showEl = elementMap[showId];
          if (showEl) {
            showEl.style.display = '';
            showEl.style.opacity = '0';
            showEl.style.transition = 'opacity 0.4s ease';
            if (showEl._label) {
              showEl._label.style.display = '';
              showEl._label.style.opacity = '0';
              showEl._label.style.transition = 'opacity 0.4s ease';
            }
            (function (el, label) {
              requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                  el.style.opacity = '1';
                  if (label) label.style.opacity = '1';
                });
              });
            })(showEl, showEl._label);
          }
        }
      }
      if (step.hide) {
        for (var h = 0; h < step.hide.length; h++) {
          var hideId = step.hide[h];
          var hideEl = elementMap[hideId];
          if (hideEl) {
            hideEl.style.transition = 'opacity 0.3s ease';
            hideEl.style.opacity = '0';
            if (hideEl._label) {
              hideEl._label.style.transition = 'opacity 0.3s ease';
              hideEl._label.style.opacity = '0';
            }
            (function (el, label) {
              setTimeout(function () {
                el.style.display = 'none';
                if (label) label.style.display = 'none';
              }, 300);
            })(hideEl, hideEl._label);
          }
        }
      }

      // 更新面板
      stepTitle.textContent = (idx + 1) + '. ' + step.title;
      stepDesc.textContent = step.description || '';
      progress.textContent = (idx + 1) + ' / ' + steps.length;
      prevBtn.disabled = (idx === 0);
      nextBtn.disabled = (idx === steps.length - 1);
      nextBtn.textContent = (idx === steps.length - 1) ? '完成' : '下一步';
    }

    prevBtn.addEventListener('click', function () {
      if (currentStep > 0) goToStep(currentStep - 1);
    });
    nextBtn.addEventListener('click', function () {
      if (currentStep < steps.length - 1) goToStep(currentStep + 1);
    });

    // 自动进入第一步
    setTimeout(function () { goToStep(0); }, 200);
  }

  container.innerHTML = '';
  container.appendChild(wrapper);
}

/**
 * 渲染单个图形元素
 */
function renderDiagramElement(def, svg) {
  var el = null;
  var labelEl = null;

  switch (def.kind) {
    case 'rect':
      el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', def.x);
      el.setAttribute('y', def.y);
      el.setAttribute('width', def.w || 60);
      el.setAttribute('height', def.h || 40);
      el.setAttribute('fill', def.fill || '#e8e8ee');
      el.setAttribute('stroke', def.stroke || '#4a4a5e');
      el.setAttribute('stroke-width', def.strokeWidth || 1.5);
      el.setAttribute('rx', 2);
      break;

    case 'circle':
      el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('cx', def.x);
      el.setAttribute('cy', def.y);
      el.setAttribute('r', def.r || 15);
      el.setAttribute('fill', def.fill || '#ffd700');
      el.setAttribute('stroke', def.stroke || '#d4a017');
      el.setAttribute('stroke-width', def.strokeWidth || 1);
      break;

    case 'line':
      el = document.createElementNS(SVG_NS, 'line');
      el.setAttribute('x1', def.x);
      el.setAttribute('y1', def.y);
      el.setAttribute('x2', def.x2 || def.x);
      el.setAttribute('y2', def.y2 || def.y);
      el.setAttribute('stroke', def.stroke || '#4a4a5e');
      el.setAttribute('stroke-width', def.strokeWidth || 2);
      break;

    case 'text':
      el = document.createElementNS(SVG_NS, 'text');
      el.setAttribute('x', def.x);
      el.setAttribute('y', def.y);
      el.setAttribute('font-size', def.fontSize || 14);
      el.setAttribute('fill', def.fill || '#1a1a2e');
      el.setAttribute('text-anchor', 'middle');
      el.textContent = def.text || '';
      break;

    case 'bar':
      // 条形模型：一个带标签的长条
      el = document.createElementNS(SVG_NS, 'g');
      var barRect = document.createElementNS(SVG_NS, 'rect');
      barRect.setAttribute('x', def.x);
      barRect.setAttribute('y', def.y);
      barRect.setAttribute('width', def.w || 80);
      barRect.setAttribute('height', def.h || 30);
      barRect.setAttribute('fill', def.fill || '#4b3fe3');
      barRect.setAttribute('stroke', def.stroke || '#3a2fd0');
      barRect.setAttribute('stroke-width', def.strokeWidth || 1);
      barRect.setAttribute('rx', 3);
      el.appendChild(barRect);
      // bar 内部文字
      if (def.text) {
        var barText = document.createElementNS(SVG_NS, 'text');
        barText.setAttribute('x', def.x + (def.w || 80) / 2);
        barText.setAttribute('y', def.y + (def.h || 30) / 2 + 5);
        barText.setAttribute('font-size', def.fontSize || 13);
        barText.setAttribute('fill', '#fff');
        barText.setAttribute('text-anchor', 'middle');
        barText.setAttribute('font-weight', 'bold');
        barText.textContent = def.text;
        el.appendChild(barText);
      }
      break;

    case 'bracket':
      // 花括号/括号标记：用路径绘制
      el = document.createElementNS(SVG_NS, 'g');
      var bx = def.x, by = def.y, bw = def.w || 80, bh = def.h || 20;
      var path = document.createElementNS(SVG_NS, 'path');
      var d = 'M ' + bx + ' ' + by +
              ' L ' + (bx + bw / 2 - 4) + ' ' + by +
              ' L ' + (bx + bw / 2) + ' ' + (by + 4) +
              ' L ' + (bx + bw / 2 + 4) + ' ' + by +
              ' L ' + (bx + bw) + ' ' + by;
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', def.stroke || '#6b6b80');
      path.setAttribute('stroke-width', 1.5);
      el.appendChild(path);
      if (def.text) {
        var bracketText = document.createElementNS(SVG_NS, 'text');
        bracketText.setAttribute('x', bx + bw / 2);
        bracketText.setAttribute('y', by - 4);
        bracketText.setAttribute('font-size', def.fontSize || 12);
        bracketText.setAttribute('fill', def.fill || '#6b6b80');
        bracketText.setAttribute('text-anchor', 'middle');
        bracketText.textContent = def.text;
        el.appendChild(bracketText);
      }
      break;

    default:
      return null;
  }

  if (el) {
    svg.appendChild(el);

    // 标签处理（非 bar/bracket 类型，它们自带 text）
    if (def.label && def.kind !== 'bar' && def.kind !== 'bracket') {
      labelEl = document.createElementNS(SVG_NS, 'text');
      var lx = def.x, ly = def.y;
      var anchor = 'middle';
      switch (def.labelPos) {
        case 'top':
          ly = def.y - 6;
          lx = def.x + (def.w || def.r * 2 || 0) / 2;
          break;
        case 'bottom':
          ly = def.y + (def.h || def.r * 2 || 20) + 16;
          lx = def.x + (def.w || def.r * 2 || 0) / 2;
          break;
        case 'left':
          lx = def.x - 8;
          ly = def.y + (def.h || 0) / 2 + 4;
          anchor = 'end';
          break;
        case 'right':
          lx = def.x + (def.w || def.r * 2 || 40) + 8;
          ly = def.y + (def.h || 0) / 2 + 4;
          anchor = 'start';
          break;
      }
      labelEl.setAttribute('x', lx);
      labelEl.setAttribute('y', ly);
      labelEl.setAttribute('font-size', def.fontSize || 12);
      labelEl.setAttribute('fill', '#4a4a5e');
      labelEl.setAttribute('text-anchor', anchor);
      labelEl.textContent = def.label;
      svg.appendChild(labelEl);

      // 如果父元素有 id，标签也跟着显示/隐藏
      if (def.id) {
        // 把 labelEl 也加入 elementMap（通过包装）
        el._label = labelEl;
      }
    }
  }

  return el;
}
