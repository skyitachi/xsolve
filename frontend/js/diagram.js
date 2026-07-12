// ========== 画图法/图形法 交互式 SVG 渲染引擎 ==========
// 将 AI 生成的 Diagram Spec JSON 渲染为带分步动画的交互式 SVG
// 支持: geometry (矩形/三角形/圆/线段/文字) 和 bar-model (条形模型)
//       number-line (数轴) area-model (面积模型) pie (饼图) flow-chart (线段图)

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

    // 自动播放按钮
    var autoBtn = document.createElement('button');
    autoBtn.className = 'diagram-btn diagram-btn-auto';
    autoBtn.textContent = '▶ 自动播放';
    var autoPlaying = false;
    var autoTimer = null;

    stepControls.appendChild(prevBtn);
    stepControls.appendChild(progress);
    stepControls.appendChild(nextBtn);
    stepsPanel.appendChild(stepControls);

    var autoControls = document.createElement('div');
    autoControls.className = 'diagram-step-controls';
    autoControls.style.marginTop = '0.375rem';
    autoControls.appendChild(autoBtn);
    stepsPanel.appendChild(autoControls);
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
      if (currentStep > 0) {
        stopAutoPlay();
        goToStep(currentStep - 1);
      }
    });
    nextBtn.addEventListener('click', function () {
      if (currentStep < steps.length - 1) {
        stopAutoPlay();
        goToStep(currentStep + 1);
      } else {
        stopAutoPlay();
      }
    });

    function startAutoPlay() {
      autoPlaying = true;
      autoBtn.textContent = '⏸ 暂停';
      autoBtn.classList.add('playing');
      // 如果已到最后一步，从头开始
      if (currentStep >= steps.length - 1) {
        goToStep(0);
      }
      autoTimer = setInterval(function () {
        if (currentStep < steps.length - 1) {
          goToStep(currentStep + 1);
        } else {
          stopAutoPlay();
        }
      }, 2500);
    }

    function stopAutoPlay() {
      autoPlaying = false;
      autoBtn.textContent = '▶ 自动播放';
      autoBtn.classList.remove('playing');
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
    }

    autoBtn.addEventListener('click', function () {
      if (autoPlaying) {
        stopAutoPlay();
      } else {
        startAutoPlay();
      }
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

    case 'arrow':
      // 箭头线段：从 (x,y) 到 (x2,y2)，终点带箭头
      el = document.createElementNS(SVG_NS, 'g');
      var ax1 = def.x, ay1 = def.y, ax2 = def.x2 || def.x, ay2 = def.y2 || def.y;
      // 计算箭头方向
      var angle = Math.atan2(ay2 - ay1, ax2 - ax1);
      var arrowLen = 8;
      var aAngle = Math.PI / 6;
      var lx1 = ax2 - arrowLen * Math.cos(angle - aAngle);
      var ly1 = ay2 - arrowLen * Math.sin(angle - aAngle);
      var lx2 = ax2 - arrowLen * Math.cos(angle + aAngle);
      var ly2 = ay2 - arrowLen * Math.sin(angle + aAngle);
      var arrowLine = document.createElementNS(SVG_NS, 'line');
      arrowLine.setAttribute('x1', ax1);
      arrowLine.setAttribute('y1', ay1);
      arrowLine.setAttribute('x2', ax2);
      arrowLine.setAttribute('y2', ay2);
      arrowLine.setAttribute('stroke', def.stroke || '#4a4a5e');
      arrowLine.setAttribute('stroke-width', def.strokeWidth || 2);
      el.appendChild(arrowLine);
      var arrowHead1 = document.createElementNS(SVG_NS, 'line');
      arrowHead1.setAttribute('x1', ax2);
      arrowHead1.setAttribute('y1', ay2);
      arrowHead1.setAttribute('x2', lx1);
      arrowHead1.setAttribute('y2', ly1);
      arrowHead1.setAttribute('stroke', def.stroke || '#4a4a5e');
      arrowHead1.setAttribute('stroke-width', def.strokeWidth || 2);
      el.appendChild(arrowHead1);
      var arrowHead2 = document.createElementNS(SVG_NS, 'line');
      arrowHead2.setAttribute('x1', ax2);
      arrowHead2.setAttribute('y1', ay2);
      arrowHead2.setAttribute('x2', lx2);
      arrowHead2.setAttribute('y2', ly2);
      arrowHead2.setAttribute('stroke', def.stroke || '#4a4a5e');
      arrowHead2.setAttribute('stroke-width', def.strokeWidth || 2);
      el.appendChild(arrowHead2);
      // 箭头上方标签
      if (def.label) {
        var arrowLabel = document.createElementNS(SVG_NS, 'text');
        var midX = (ax1 + ax2) / 2;
        var midY = (ay1 + ay2) / 2 - 6;
        arrowLabel.setAttribute('x', midX);
        arrowLabel.setAttribute('y', midY);
        arrowLabel.setAttribute('font-size', def.fontSize || 12);
        arrowLabel.setAttribute('fill', def.fill || '#4a4a5e');
        arrowLabel.setAttribute('text-anchor', 'middle');
        arrowLabel.textContent = def.label;
        el.appendChild(arrowLabel);
      }
      break;

    case 'pie-slice':
      // 饼图扇形：圆心 (x,y)，半径 r，起始角度 startAngle，结束角度 endAngle（度）
      el = document.createElementNS(SVG_NS, 'path');
      var pCx = def.x, pCy = def.y, pR = def.r || 60;
      var pStart = (def.startAngle || 0) * Math.PI / 180;
      var pEnd = (def.endAngle || 90) * Math.PI / 180;
      var pX1 = pCx + pR * Math.cos(pStart);
      var pY1 = pCy + pR * Math.sin(pStart);
      var pX2 = pCx + pR * Math.cos(pEnd);
      var pY2 = pCy + pR * Math.sin(pEnd);
      var pLargeArc = (def.endAngle || 90) - (def.startAngle || 0) > 180 ? 1 : 0;
      var pD = 'M ' + pCx + ' ' + pCy +
               ' L ' + pX1 + ' ' + pY1 +
               ' A ' + pR + ' ' + pR + ' 0 ' + pLargeArc + ' 1 ' + pX2 + ' ' + pY2 +
               ' Z';
      el.setAttribute('d', pD);
      el.setAttribute('fill', def.fill || '#4b3fe3');
      el.setAttribute('stroke', def.stroke || '#fff');
      el.setAttribute('stroke-width', def.strokeWidth || 2);
      break;

    case 'pie-circle':
      // 饼图底层圆（用于先画一个完整圆，再叠加扇形）
      el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('cx', def.x);
      el.setAttribute('cy', def.y);
      el.setAttribute('r', def.r || 60);
      el.setAttribute('fill', def.fill || '#f0f0f3');
      el.setAttribute('stroke', def.stroke || '#ccc');
      el.setAttribute('stroke-width', def.strokeWidth || 1);
      break;

    case 'segment':
      // 线段图元素：带粗线和端点标记的水平线段
      // x,y 是起点，w 是长度，h 是线段高度位置
      el = document.createElementNS(SVG_NS, 'g');
      var segX = def.x, segY = def.y, segW = def.w || 80, segH = def.h || 24;
      // 主线段
      var segLine = document.createElementNS(SVG_NS, 'rect');
      segLine.setAttribute('x', segX);
      segLine.setAttribute('y', segY);
      segLine.setAttribute('width', segW);
      segLine.setAttribute('height', segH);
      segLine.setAttribute('fill', def.fill || '#4b3fe3');
      segLine.setAttribute('stroke', def.stroke || '#3a2fd0');
      segLine.setAttribute('stroke-width', def.strokeWidth || 1);
      segLine.setAttribute('rx', 2);
      el.appendChild(segLine);
      // 端点竖线
      var segEnd1 = document.createElementNS(SVG_NS, 'line');
      segEnd1.setAttribute('x1', segX);
      segEnd1.setAttribute('y1', segY - 4);
      segEnd1.setAttribute('x2', segX);
      segEnd1.setAttribute('y2', segY + segH + 4);
      segEnd1.setAttribute('stroke', def.stroke || '#3a2fd0');
      segEnd1.setAttribute('stroke-width', 2);
      el.appendChild(segEnd1);
      var segEnd2 = document.createElementNS(SVG_NS, 'line');
      segEnd2.setAttribute('x1', segX + segW);
      segEnd2.setAttribute('y1', segY - 4);
      segEnd2.setAttribute('x2', segX + segW);
      segEnd2.setAttribute('y2', segY + segH + 4);
      segEnd2.setAttribute('stroke', def.stroke || '#3a2fd0');
      segEnd2.setAttribute('stroke-width', 2);
      el.appendChild(segEnd2);
      // 文字
      if (def.text) {
        var segText = document.createElementNS(SVG_NS, 'text');
        segText.setAttribute('x', segX + segW / 2);
        segText.setAttribute('y', segY + segH / 2 + 5);
        segText.setAttribute('font-size', def.fontSize || 13);
        segText.setAttribute('fill', '#fff');
        segText.setAttribute('text-anchor', 'middle');
        segText.setAttribute('font-weight', 'bold');
        segText.textContent = def.text;
        el.appendChild(segText);
      }
      break;

    case 'number-line':
      // 数轴：起点 x,y，长度 w，范围从 min 到 max，步长 step
      // 自动绘制刻度和数字
      el = document.createElementNS(SVG_NS, 'g');
      var nlX = def.x, nlY = def.y, nlW = def.w || 280;
      var nlMin = def.min || 0, nlMax = def.max || 10, nlStep = def.step || 1;
      var nlRange = nlMax - nlMin;
      if (nlRange <= 0) nlRange = 1;
      // 主轴线
      var nlAxis = document.createElementNS(SVG_NS, 'line');
      nlAxis.setAttribute('x1', nlX);
      nlAxis.setAttribute('y1', nlY);
      nlAxis.setAttribute('x2', nlX + nlW);
      nlAxis.setAttribute('y2', nlY);
      nlAxis.setAttribute('stroke', def.stroke || '#4a4a5e');
      nlAxis.setAttribute('stroke-width', 2);
      el.appendChild(nlAxis);
      // 右箭头
      var nlArrow = document.createElementNS(SVG_NS, 'path');
      nlArrow.setAttribute('d', 'M ' + (nlX + nlW) + ' ' + nlY +
                           ' L ' + (nlX + nlW - 8) + ' ' + (nlY - 4) +
                           ' L ' + (nlX + nlW - 8) + ' ' + (nlY + 4) + ' Z');
      nlArrow.setAttribute('fill', def.stroke || '#4a4a5e');
      el.appendChild(nlArrow);
      // 刻度和数字
      for (var nlVal = nlMin; nlVal <= nlMax + 0.001; nlVal += nlStep) {
        var nlTickX = nlX + ((nlVal - nlMin) / nlRange) * nlW;
        // 刻度线
        var nlTick = document.createElementNS(SVG_NS, 'line');
        nlTick.setAttribute('x1', nlTickX);
        nlTick.setAttribute('y1', nlY - 5);
        nlTick.setAttribute('x2', nlTickX);
        nlTick.setAttribute('y2', nlY + 5);
        nlTick.setAttribute('stroke', def.stroke || '#4a4a5e');
        nlTick.setAttribute('stroke-width', 1.5);
        el.appendChild(nlTick);
        // 数字标签
        var nlNum = document.createElementNS(SVG_NS, 'text');
        nlNum.setAttribute('x', nlTickX);
        nlNum.setAttribute('y', nlY + 20);
        nlNum.setAttribute('font-size', def.fontSize || 11);
        nlNum.setAttribute('fill', '#6b6b80');
        nlNum.setAttribute('text-anchor', 'middle');
        // 整数显示不带小数
        nlNum.textContent = (nlVal % 1 === 0) ? nlVal.toString() : nlVal.toFixed(1);
        el.appendChild(nlNum);
      }
      break;

    case 'nl-point':
      // 数轴上的点标记：x,y 是数轴位置，值由 x 映射
      // 需要配合 number-line 使用，x 是画布坐标
      el = document.createElementNS(SVG_NS, 'g');
      var ptX = def.x, ptY = def.y || 140;
      // 点
      var ptCircle = document.createElementNS(SVG_NS, 'circle');
      ptCircle.setAttribute('cx', ptX);
      ptCircle.setAttribute('cy', ptY);
      ptCircle.setAttribute('r', def.r || 6);
      ptCircle.setAttribute('fill', def.fill || '#e74c3c');
      ptCircle.setAttribute('stroke', '#fff');
      ptCircle.setAttribute('stroke-width', 2);
      el.appendChild(ptCircle);
      // 上方标签
      if (def.text) {
        var ptText = document.createElementNS(SVG_NS, 'text');
        ptText.setAttribute('x', ptX);
        ptText.setAttribute('y', ptY - 12);
        ptText.setAttribute('font-size', def.fontSize || 13);
        ptText.setAttribute('fill', def.fill || '#e74c3c');
        ptText.setAttribute('text-anchor', 'middle');
        ptText.setAttribute('font-weight', 'bold');
        ptText.textContent = def.text;
        el.appendChild(ptText);
      }
      break;

    case 'nl-range':
      // 数轴上的区间标记：从 x1 到 x2 的弧形区间
      el = document.createElementNS(SVG_NS, 'g');
      var rgX1 = def.x, rgX2 = def.x2 || def.x, rgY = def.y || 140;
      var rgH = def.h || 20;
      // 弧形路径
      var rgPath = document.createElementNS(SVG_NS, 'path');
      var rgMidX = (rgX1 + rgX2) / 2;
      var rgD = 'M ' + rgX1 + ' ' + rgY +
                ' Q ' + rgMidX + ' ' + (rgY - rgH) + ' ' + rgX2 + ' ' + rgY;
      rgPath.setAttribute('d', rgD);
      rgPath.setAttribute('fill', 'none');
      rgPath.setAttribute('stroke', def.stroke || '#e74c3c');
      rgPath.setAttribute('stroke-width', def.strokeWidth || 2);
      el.appendChild(rgPath);
      // 标签
      if (def.text) {
        var rgText = document.createElementNS(SVG_NS, 'text');
        rgText.setAttribute('x', rgMidX);
        rgText.setAttribute('y', rgY - rgH - 4);
        rgText.setAttribute('font-size', def.fontSize || 12);
        rgText.setAttribute('fill', def.fill || '#e74c3c');
        rgText.setAttribute('text-anchor', 'middle');
        rgText.textContent = def.text;
        el.appendChild(rgText);
      }
      break;

    case 'grid-cell':
      // 面积模型的格子：单个网格单元
      el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', def.x);
      el.setAttribute('y', def.y);
      el.setAttribute('width', def.w || 30);
      el.setAttribute('height', def.h || 30);
      el.setAttribute('fill', def.fill || '#e8e8ee');
      el.setAttribute('stroke', def.stroke || '#bbb');
      el.setAttribute('stroke-width', def.strokeWidth || 1);
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
