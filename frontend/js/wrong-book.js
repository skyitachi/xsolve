// ========== 错题本页面 ==========
//
// 三种录入入口在这里汇合：
//   自动收录 —— 在后台（答错时），页面只管展示
//   从题库加 —— 「➕ 从题库加题」挑已有题目
//   拍照录入 —— 「📷 拍照录入」拍照 → 裁剪 → 视觉解析 → 核对后保存
//
// 拍照这条链路刻意是**两步**（先 parse 再 commit），而不是一次提交就落库：
// 视觉模型会把印刷体看错、把学生的手写当成题干，直接入库会产生垃圾题，
// 而且错题本是要反复看的，脏数据比没有更糟。
(function () {
  if (!window.XsolveAuth) return;

  var S = {
    books: [],
    stats: null,
    items: [],
    bookId: null,
    // 三种视图：待复习（默认）/ 全部 / 已掌握。
    // 与「错题本」是两回事 —— 本子是归属，这里筛的是复习进度。
    tab: 'due',
    showAllDue: false,   // 绕过每日上限看全部到期
    dueTotal: 0,
    dailyLimit: 0,
    detail: null,
    photoImage: null,
    candidates: [],
    loading: false,
  };

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 统一请求：解析 JSON，非 2xx 抛出带后端 error 文案的异常
  function j(url, opts) {
    return XsolveAuth.api(url, opts).then(function (resp) {
      return resp.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
        if (!resp.ok) {
          var err = new Error(data.error || ('请求失败（HTTP ' + resp.status + '）'));
          err.status = resp.status;
          throw err;
        }
        return data;
      });
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#wb-toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function busy(on, text) {
    $('#wb-busy-text').textContent = text || '处理中…';
    $('#wb-busy').hidden = !on;
  }

  function openSheet(id) { $('#' + id).hidden = false; }
  function closeSheet(id) { $('#' + id).hidden = true; }

  /**
   * 把节点里的 $...$ / $$...$$ 渲染成真正的数学公式。
   * 错题本里几乎每条都是数学题，不渲染的话孩子看到的是 `$\frac{2}{5}$` 这种源码，
   * 完全不可读。KaTeX 走的 vendor 本地文件（与做题页同一份），不依赖外网。
   * 渲染失败就保持原样，不能因为公式挂了就白屏。
   */
  /**
   * 公式渲染的失败是**静默**的：页面不报错、文字也还在，只是没变成公式。
   * 这种问题只靠现象极难反推（本项目已经栽过一次 —— 靠截图才发现孩子看到的是
   * `$\frac{2}{5}$` 源码），所以把最近几次渲染的成败挂到 window 上，
   * 回归脚本和人工排查都能直接读，而不是猜。
   */
  function noteMath(ok, detail) {
    try {
      var d = window.__wbMath || (window.__wbMath = { calls: 0, ok: 0, failed: 0, notReady: 0, last: [] });
      d.calls++;
      if (ok) d.ok++;
      else if (detail === 'not-ready') d.notReady++;
      else d.failed++;
      d.last.push(ok ? 'ok' : (detail || 'failed'));
      if (d.last.length > 10) d.last.shift();
    } catch (e) { /* 诊断自身出错绝不能影响渲染 */ }
  }

  /**
   * KaTeX 是 `defer` 脚本，而本文件是普通脚本 —— 列表数据回来时它可能还没加载完。
   * 此时 renderMath 只能静默返回，**公式就永远停在 `$x$` 源码**（页面不报错，极易蒙混过关）。
   * 所以未就绪时把元素排队，等 KaTeX 到位后补渲一次，不依赖脚本加载顺序。
   */
  var mathQueue = [];
  var mathTimer = null;

  function flushMathQueue() {
    if (typeof window.renderMathInElement !== 'function') return false;
    if (mathTimer) { clearInterval(mathTimer); mathTimer = null; }
    var q = mathQueue.splice(0, mathQueue.length);
    q.forEach(function (n) { if (n && n.isConnected) renderMath(n); });
    return true;
  }

  function queueMath(el) {
    if (mathQueue.indexOf(el) === -1) mathQueue.push(el);
    if (mathTimer) return;
    var tries = 0;
    mathTimer = setInterval(function () {
      tries++;
      // 最多等 5s：实在加载不出来就放弃，不要留一个永久轮询在后台
      if (flushMathQueue() || tries > 100) {
        if (mathTimer) { clearInterval(mathTimer); mathTimer = null; }
        mathQueue.length = 0;
      }
    }, 50);
  }

  function renderMath(el) {
    if (!el) { noteMath(false, 'no-el'); return; }
    if (typeof window.renderMathInElement !== 'function') {
      noteMath(false, 'not-ready');
      queueMath(el);
      return;
    }
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'option'],
      });
      noteMath(true);
    } catch (e) {
      noteMath(false, (e && e.message) || 'throw');
    }
  }

  // ========== 数据加载 ==========

  function loadBooks() {
    return j('/api/wrong-book/books').then(function (data) {
      S.books = data.books || [];
      S.stats = data.stats || null;
      if (!S.bookId || !S.books.some(function (b) { return b.id === S.bookId; })) {
        var def = S.books.filter(function (b) { return b.is_default; })[0] || S.books[0];
        S.bookId = def ? def.id : null;
      }
      renderBooks();
      renderStats();
    });
  }

  function loadItems() {
    if (!S.bookId) { S.items = []; S.dueTotal = 0; renderList(); renderLimit(); return Promise.resolve(); }
    var q = '/api/wrong-book/items?bookId=' + encodeURIComponent(S.bookId);
    if (S.tab === 'due') q += '&status=due' + (S.showAllDue ? '&all=1' : '');
    else if (S.tab === 'mastered') q += '&status=mastered';
    return j(q).then(function (data) {
      S.items = data.items || [];
      S.dueTotal = data.due_total || 0;
      S.dailyLimit = data.daily_limit || 0;
      renderList();
      renderLimit();
    });
  }

  function switchTab(tab) {
    if (S.tab === tab) return;
    S.tab = tab;
    S.showAllDue = false;
    Array.prototype.forEach.call($('#wb-tabs').querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    loadItems().catch(function (e) { toast(e.message); });
  }

  function refresh() {
    return loadBooks().then(loadItems).catch(function (e) {
      toast(e.message || '加载失败');
    });
  }

  // ========== 渲染 ==========

  function renderStats() {
    var st = S.stats || { due: 0, mastered: 0, total: 0 };
    $('#st-due').textContent = st.due || 0;
    $('#st-mastered').textContent = st.mastered || 0;
    $('#st-total').textContent = st.total || 0;
    var bits = [];
    if (st.overdue_days) bits.push('最久未练 ' + st.overdue_days + ' 天');
    if (st.last7_mastered) bits.push('近 7 天清掉 ' + st.last7_mastered + ' 道');
    $('#st-line').textContent = bits.join(' · ');
  }

  // 每日上限提示：让「被截断」这件事可见，而不是静默少给几道题
  function renderLimit() {
    var el = $('#wb-limit');
    var hidden = S.tab !== 'due' || !S.dailyLimit || S.showAllDue
      || S.dueTotal <= S.items.length;
    if (hidden) { el.hidden = true; return; }
    $('#wb-limit-text').textContent = '还有 ' + (S.dueTotal - S.items.length) + ' 道到期，今天先练这 '
      + S.items.length + ' 道就行';
    el.hidden = false;
  }

  function renderBooks() {
    var html = S.books.map(function (b) {
      return '<button class="book-chip' + (b.id === S.bookId ? ' active' : '')
        + '" data-book="' + esc(b.id) + '">'
        + esc(b.emoji || '📕') + ' ' + esc(b.name)
        + '<span class="n">' + (b.pending || 0) + '</span></button>';
    }).join('');
    html += '<button class="book-chip add" id="wb-add-book">＋ 新建</button>';
    $('#wb-books').innerHTML = html;

    Array.prototype.forEach.call($('#wb-books').querySelectorAll('[data-book]'), function (el) {
      el.addEventListener('click', function () {
        S.bookId = el.getAttribute('data-book');
        renderBooks();
        loadItems().catch(function (e) { toast(e.message); });
      });
    });
    var addBtn = $('#wb-add-book');
    if (addBtn) addBtn.addEventListener('click', function () {
      $('#bk-name').value = '';
      openSheet('sheet-book');
      setTimeout(function () { $('#bk-name').focus(); }, 60);
    });
  }

  var SRC_LABEL = { auto: '做错了', manual: '手动加入', photo: '拍照录入' };
  var LV_MAX = 4;   // 与后端 WRONG_BOOK_REVIEW_INTERVALS 的长度一致（等级 0~4）

  function nowSec() { return Math.floor(Date.now() / 1000); }

  // 记忆等级用几格小方块表示 —— 比「等级 2」更容易被孩子理解成「快到了」
  function lvDots(level) {
    var n = Math.max(0, Math.min(Number(level) || 0, LV_MAX));
    var out = '<span class="lvbar" title="记忆等级 ' + n + '/' + LV_MAX + '">';
    for (var i = 0; i < LV_MAX; i++) out += '<span class="lvdot' + (i < n ? ' on' : '') + '"></span>';
    return out + '</span>';
  }

  function schedText(it) {
    if (it.status === 'mastered') return '<span class="due-later">已掌握</span>';
    if (!it.next_review_at || it.next_review_at <= nowSec()) {
      return '<span class="due-now">今天该练</span>';
    }
    return '<span class="due-later">' + fmtDay(it.next_review_at) + ' 再练</span>';
  }

  function errTag(it) {
    if (!it.error_type) return '<span class="tag err-none">未归因</span>';
    return '<span class="tag err">' + esc(it.error_type) + '</span>';
  }

  function renderList() {
    var el = $('#wb-list');
    if (!S.items.length) {
      el.innerHTML = '';
      renderEmpty();
      $('#wb-empty').hidden = false;
      return;
    }
    $('#wb-empty').hidden = true;
    el.innerHTML = S.items.map(function (it) {
      var mastered = it.status === 'mastered';
      var srcCls = it.source === 'auto' ? 'src-auto' : (it.source === 'photo' ? 'src-photo' : '');
      return '<div class="item' + (mastered ? ' mastered' : '') + '" data-item="' + esc(it.id) + '">'
        + '<div class="row1">'
        + '<span class="tag">' + esc(it.topic || '未分类') + '</span>'
        + '<span class="tag ' + srcCls + '">' + esc(SRC_LABEL[it.source] || it.source) + '</span>'
        + errTag(it)
        + (mastered ? '<span class="tag" style="background:#e6f7ef;color:#2f9e6e;">已掌握</span>' : '')
        + (it.problem_exists === false ? '<span class="tag warn">题目已删除</span>' : '')
        + '</div>'
        + '<div class="txt">' + esc(it.text || '（题面缺失）') + '</div>'
        + '<div class="sched">' + lvDots(it.level) + schedText(it)
        + (it.review_streak ? '<span>连对 ' + it.review_streak + '</span>' : '')
        + '</div>'
        + '<div class="meta">'
        + (it.wrong_count > 1 ? '<span>错 ' + it.wrong_count + ' 次</span>' : '')
        + (it.review_count ? '<span>重做 ' + it.review_count + ' 次</span>' : '')
        + '<span>' + fmtDate(it.created_at) + ' 加入</span>'
        + '</div></div>';
    }).join('');

    Array.prototype.forEach.call(el.querySelectorAll('[data-item]'), function (node) {
      node.addEventListener('click', function () {
        openDetail(node.getAttribute('data-item'));
      });
    });
    renderMath(el);
  }

  /**
   * 空态必须区分两种完全不同的情况：
   *   ① 整个错题本是空的 → 引导去做题（这是新用户看到的第一屏）
   *   ② 今天没有到期的   → 鼓励 + 告诉他下次什么时候到期
   * 混成一句「没有错题」是常见的体验瑕疵：已经清完错题的孩子会以为哪儿出错了。
   */
  function renderEmpty() {
    var st = S.stats || {};
    var icon = $('#wb-empty-icon'), title = $('#wb-empty-title'), sub = $('#wb-empty-sub');
    if (S.tab === 'mastered') {
      icon.textContent = '🌱';
      title.textContent = '还没有已掌握的题';
      sub.textContent = '连续重做答对，或手动标记「已掌握」之后，题会移到这里。';
      return;
    }
    if (S.tab === 'due' && (st.total || 0) > 0) {
      icon.textContent = '🎉';
      title.textContent = '今天没有到期要复习的';
      sub.textContent = st.next_due_at
        ? '下次到期：' + fmtDay(st.next_due_at) + '。可以去学点新的。'
        : '都清干净了，可以去学点新的。';
      return;
    }
    icon.textContent = '📭';
    title.textContent = '这个错题本还是空的';
    sub.textContent = '做题答错会自动进来；也可以拍照录入，或从题库里挑。';
  }

  function fmtDate(ts) {
    if (!ts) return '-';
    var d = new Date(ts * 1000);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  // 「X月X日」——复习排期用它，比 3/7 更明确（孩子要看的是"哪天"）
  function fmtDay(ts) {
    if (!ts) return '稍后';
    var d = new Date(ts * 1000);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function fmtDateTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts * 1000);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' '
      + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ========== 详情 ==========

  function openDetail(id) {
    busy(true, '加载中…');
    j('/api/wrong-book/items/' + encodeURIComponent(id)).then(function (data) {
      S.detail = data;
      var it = data.item || {};
      var p = data.problem;
      $('#dt-title').textContent = p ? (p.topic || '错题详情') : '错题详情';

      var html = '';
      if (!p) {
        html += '<div class="empty">这道题的原文已被删除，只剩错题记录。</div>';
      } else {
        html += '<div class="detail-text">' + esc(p.text) + '</div>';
        if (p.figure && p.figure.type === 'image' || it.has_image) {
          html += '<img class="detail-img" id="dt-img" alt="题目原图" />';
        }
      }
      if (data.wrong_answer && data.wrong_answer.answer) {
        html += '<div class="detail-wrong">'
          + '<div class="k">我上次写错的答案</div>'
          + '<div class="v">' + esc(data.wrong_answer.answer) + '</div>'
          + '</div>';
      }
      // ─── 错因（人工标注）───
      // 错因三层里只有这一层可靠：人知道为什么错。规则兜底会标成"系统猜的"，
      // 对话抽取本项目没做（不做比乱做诚实 —— 错因一旦不可信，整张分布图就是噪声）。
      var srcNote = it.error_source === 'rule' ? '系统猜的，可改'
        : (it.error_type ? '人工标注' : '还没标');
      html += '<div class="sec-title">错因 <span style="font-weight:400;color:#9a9aab;">（' + esc(srcNote) + '）</span></div>';
      html += '<div class="chips" id="dt-chips">'
        + (data.error_types || []).map(function (et) {
          return '<button class="chip' + (it.error_type === et ? ' on' : '') + '" data-err="' + esc(et) + '">' + esc(et) + '</button>';
        }).join('')
        + '<button class="chip" data-err="" style="color:#9a9aab;">清空</button>'
        + '</div>';
      html += '<div class="field" style="margin-top:10px;">'
        + '<label>备注（自由描述，可留空）</label>'
        + '<input id="dt-note" type="text" maxlength="200" placeholder="如：单位换算老是忘" value="'
        + esc(it.note || '') + '" /></div>';

      // ─── 复习记录 ───
      // 把「等级为什么是这个数」摊开给人看。没有这一段，复习调度就是个黑盒，
      // 家长无法判断它到底有没有在工作。
      if (data.reviews && data.reviews.length) {
        html += '<div class="sec-title">复习记录</div><div class="rev-list">'
          + data.reviews.map(function (r) {
            return '<div>' + fmtDateTime(r.at) + ' · ' + (r.correct ? '✅ 答对' : '❌ 答错')
              + (r.from_book ? '（主动重做）' : '（日常练习，不计等级）')
              + (r.level_after != null ? ' · 等级 ' + r.level_after : '')
              + '</div>';
          }).join('')
          + '</div>';
      }

      html += '<div class="meta" style="margin-top:12px;font-size:12px;color:#9a9aab;">'
        + '错 ' + (it.wrong_count || 0) + ' 次 · 重做 ' + (it.review_count || 0) + ' 次'
        + ' · 来源：' + esc(SRC_LABEL[it.source] || it.source || '-')
        + (it.last_correct_at ? ' · 最近答对：' + fmtDay(it.last_correct_at) : '')
        + '</div>';
      html += '<div class="hintline" style="margin-top:12px;font-size:11.5px;color:#9a9aab;line-height:1.6;">'
        + '「重做」会跳到做题页把这道题再做一遍。答对后等级 +1、下次复习往后推；'
        + '等级满 ' + LV_MAX + ' 且连着答对 2 次以上，自动移入「已掌握」。'
        + '平时做题答对**不算** —— 那可能是刚讲完照着做的。</div>';
      $('#dt-body').innerHTML = html;
      bindDetailMeta(id);

      // 原图单独取，避免列表接口被 base64 撑爆（这里只有一条，代价可接受）
      if ($('#dt-img')) {
        j('/api/wrong-book/items/' + encodeURIComponent(id) + '/image')
          .then(function (d) { if (d.image) $('#dt-img').src = d.image; })
          .catch(function () { var im = $('#dt-img'); if (im) im.remove(); });
      }

      $('#dt-master').textContent = it.status === 'mastered' ? '↩️ 取消已掌握' : '✅ 标记已掌握';
      $('#dt-delete').setAttribute('data-id', id);
      $('#dt-redo').setAttribute('data-id', id);
      $('#dt-master').setAttribute('data-id', id);
      openSheet('sheet-detail');
      // 公式在弹层显示后再渲染：隐藏元素上渲染虽可行，但显示后渲染更稳
      renderMath($('#dt-body'));
    }).catch(function (e) {
      toast(e.message || '打开失败');
    }).then(function () { busy(false); });
  }

  /** 绑定详情弹层里的错因标签与备注。 */
  function bindDetailMeta(id) {
    Array.prototype.forEach.call($('#dt-body').querySelectorAll('[data-err]'), function (b) {
      b.addEventListener('click', function () {
        var val = b.getAttribute('data-err');
        saveMeta(id, { error_type: val || null });
      });
    });
    var note = $('#dt-note');
    if (note) {
      var original = note.value;
      note.addEventListener('blur', function () {
        if (note.value.trim() === original.trim()) return;
        saveMeta(id, { note: note.value.trim() || null });
      });
    }
  }

  function saveMeta(id, payload) {
    return j('/api/wrong-book/items/' + encodeURIComponent(id) + '/meta', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then(function () {
      toast('已记下');
      // 重取详情与列表，让标签状态以后端为准 —— 不在前端"乐观更新"，
      // 免得规则兜底与人工标注的来源标记对不上。
      return Promise.all([openDetail(id), loadBooks().then(loadItems)]);
    }).catch(function (e) { toast(e.message || '保存失败'); });
  }

  function setMastered(id, mastered) {
    return j('/api/wrong-book/items/' + encodeURIComponent(id) + '/master', {
      method: 'POST',
      body: JSON.stringify({ mastered: mastered }),
    }).then(function () {
      closeSheet('sheet-detail');
      toast(mastered ? '已标记为掌握，不再出现在待复习里' : '已回到待复习');
      return refresh();
    }).catch(function (e) { toast(e.message || '操作失败'); });
  }

  function removeItem(id) {
    return j('/api/wrong-book/items/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () {
        closeSheet('sheet-detail');
        toast('已移出错题本');
        return refresh();
      }).catch(function (e) { toast(e.message || '删除失败'); });
  }

  function redoItem(problemId) {
    // 刻意**不**在这里记 review_count：
    //   ① 一次重做只应在"有结果"时结算一次，否则「点进去又退出来」和「真的做完」
    //      会被计成同一件事，复习进度就注水了；
    //   ② 后端 recordWrongReview 结算时会 +1，这里再记就是双计数。
    // 结果由做题页回流（深链带 from=wrongbook → 后端 PATCH session 的 review 标记）。
    location.href = '/index.html?problemId=' + encodeURIComponent(problemId) + '&from=wrongbook';
  }

  // ========== 拍照录入 ==========

  function fileToDataUrl(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(new Error('读取图片失败')); };
      r.readAsDataURL(file);
    });
  }

  // 兜底压缩：裁剪界面若被跳过（「用全图」），相册原图可能是 12MP 的巨图。
  // 直接上传既慢又容易被视觉平台拒，这里统一压到长边 1600。
  function downscaleIfHuge(dataUrl, maxEdge) {
    var approxBytes = Math.round(String(dataUrl).length * 0.75);
    if (approxBytes < 2.5 * 1024 * 1024) return Promise.resolve(dataUrl);
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var r = Math.min(1, maxEdge / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * r));
        c.height = Math.max(1, Math.round(h * r));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.9));
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }

  function handlePhotoFile(file) {
    if (!file) return;
    busy(true, '正在准备图片…');
    fileToDataUrl(file)
      .then(function (raw) {
        return downscaleIfHuge(raw, 1600);
      })
      .then(function (prepared) {
        busy(false);
        // 先裁剪：整页照片里有邻题、有边缘，裁出「本题」再识别质量差很多
        return (window.openCropDialog ? openCropDialog(prepared) : Promise.resolve(prepared));
      })
      .then(function (cropped) {
        if (!cropped) { busy(false); return null; }
        S.photoImage = cropped;
        busy(true, '正在识别题目…（约 10 秒）');
        return j('/api/wrong-book/photo/parse', {
          method: 'POST',
          body: JSON.stringify({ image: cropped }),
        }).then(function (data) {
          fillPhotoForm(data.draft || {});
          openSheet('sheet-photo');
        });
      })
      .catch(function (e) {
        var msg = String(e && e.message ? e.message : e);
        if (/heic|heif/i.test(msg) || /解码|decode/i.test(msg)) {
          msg = '这张图读不出来。iPhone 默认存 HEIC 格式，请在 设置 → 相机 → 格式 改成「兼容性最佳」，或先在相册里截个图再上传。';
        }
        toast(msg);
      })
      .then(function () { busy(false); });
  }

  function fillPhotoForm(draft) {
    $('#ph-topic').value = draft.topic || '';
    $('#ph-text').value = draft.text || '';
    $('#ph-answer').value = draft.answer || '';
    $('#ph-hints').value = (draft.hints || []).join('\n');
    $('#ph-keepimg').checked = !!draft.has_figure;
  }

  function savePhoto() {
    var draft = {
      topic: $('#ph-topic').value.trim(),
      text: $('#ph-text').value.trim(),
      answer: $('#ph-answer').value.trim(),
      hints: $('#ph-hints').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
      has_figure: $('#ph-keepimg').checked,
    };
    if (!draft.text) { toast('题面不能为空'); return; }
    if (!draft.answer) { toast('请先填写标准答案'); return; }

    busy(true, '正在保存…');
    j('/api/wrong-book/photo/commit', {
      method: 'POST',
      body: JSON.stringify({
        draft: draft,
        image: $('#ph-keepimg').checked ? S.photoImage : null,
        keep_image: $('#ph-keepimg').checked,
        bookId: S.bookId,
      }),
    }).then(function () {
      closeSheet('sheet-photo');
      S.photoImage = null;
      toast('已录入错题本 ✅');
      return refresh();
    }).catch(function (e) {
      toast(e.message || '保存失败');
    }).then(function () { busy(false); });
  }

  // ========== 从题库挑题 ==========

  function loadCandidates(q) {
    var url = '/api/wrong-book/candidates?bookId=' + encodeURIComponent(S.bookId || '')
      + (q ? '&q=' + encodeURIComponent(q) : '');
    return j(url).then(function (data) {
      S.candidates = data.problems || [];
      renderCandidates();
    });
  }

  function renderCandidates() {
    var el = $('#pk-list');
    if (!S.candidates.length) {
      el.innerHTML = '<div class="empty" style="padding:28px 10px;">没有找到题目</div>';
      return;
    }
    el.innerHTML = S.candidates.map(function (p) {
      return '<label class="pick-row' + (p.in_this_book ? ' in-book' : '') + '">'
        + '<input type="checkbox" value="' + esc(p.id) + '"'
        + (p.in_this_book ? ' checked disabled' : '') + ' />'
        + '<span class="body">'
        + '<span class="t">' + esc(p.text || '（无题面）') + '</span>'
        + '<span class="s">' + esc(p.topic || '未分类')
        + (p.has_image ? ' · 有图' : '')
        + (p.in_book ? ' · 已在错题本里' : '')
        + '</span></span></label>';
    }).join('');
  }

  function addSelected() {
    var ids = Array.prototype.slice
      .call($('#pk-list').querySelectorAll('input[type=checkbox]:checked:not(:disabled)'))
      .map(function (i) { return i.value; });
    if (!ids.length) { toast('先勾选要加入的题目'); return; }
    busy(true, '正在加入…');
    j('/api/wrong-book/items', {
      method: 'POST',
      body: JSON.stringify({ problemIds: ids, bookId: S.bookId }),
    }).then(function (data) {
      closeSheet('sheet-pick');
      toast(data.message || '已加入');
      return refresh();
    }).catch(function (e) {
      toast(e.message || '加入失败');
    }).then(function () { busy(false); });
  }

  // ========== 事件绑定 ==========

  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
    b.addEventListener('click', function () { closeSheet(b.getAttribute('data-close')); });
  });
  // 点遮罩关闭（点内容区不关）
  Array.prototype.forEach.call(document.querySelectorAll('.sheet'), function (sh) {
    sh.addEventListener('click', function (e) {
      if (e.target === sh) sh.hidden = true;
    });
  });

  $('#wb-photo-btn').addEventListener('click', function () { $('#wb-photo-camera').click(); });
  $('#wb-album-btn').addEventListener('click', function () { $('#wb-photo-album').click(); });

  [['#wb-photo-camera'], ['#wb-photo-album']].forEach(function (pair) {
    var el = $(pair[0]);
    el.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = ''; // 同一张图连拍两次也能再次触发
      if (file) handlePhotoFile(file);
    });
  });

  Array.prototype.forEach.call($('#wb-tabs').querySelectorAll('.tab'), function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });

  // 每日上限的逃生口：学生自己点「看全部到期」时才放开，不是默认行为
  $('#wb-limit-all').addEventListener('click', function () {
    S.showAllDue = true;
    loadItems().catch(function (e) { toast(e.message); });
  });

  $('#wb-pick-btn').addEventListener('click', function () {
    openSheet('sheet-pick');
    busy(true, '加载题库…');
    loadCandidates('').catch(function (e) { toast(e.message); })
      .then(function () { busy(false); });
  });

  var searchTimer = null;
  $('#pk-search').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      loadCandidates(v).catch(function (e) { toast(e.message); });
    }, 260);
  });

  $('#pk-add').addEventListener('click', addSelected);
  $('#ph-save').addEventListener('click', savePhoto);

  $('#dt-master').addEventListener('click', function () {
    var id = this.getAttribute('data-id');
    var wantMastered = this.textContent.indexOf('取消') === -1;
    setMastered(id, wantMastered);
  });
  $('#dt-delete').addEventListener('click', function () {
    var id = this.getAttribute('data-id');
    if (confirm('把这道题移出错题本？（题目本身不会被删除）')) removeItem(id);
  });
  $('#dt-redo').addEventListener('click', function () {
    var pid = S.detail && S.detail.item ? S.detail.item.problem_id : null;
    if (!pid) { toast('这道题的原题已被删除，无法重做'); return; }
    redoItem(pid);
  });

  $('#bk-save').addEventListener('click', function () {
    var name = $('#bk-name').value.trim();
    if (!name) { toast('给错题本起个名字'); return; }
    busy(true, '创建中…');
    j('/api/wrong-book/books', {
      method: 'POST',
      body: JSON.stringify({ name: name, emoji: $('#bk-emoji').value.trim() || '📗' }),
    }).then(function (data) {
      closeSheet('sheet-book');
      S.bookId = data.book.id;
      toast('错题本已创建');
      return refresh();
    }).catch(function (e) {
      toast(e.message || '创建失败');
    }).then(function () { busy(false); });
  });

  // ========== 启动 ==========
  (async function boot() {
    var user = await XsolveAuth.ready;
    if (!user) return;
    if (window.XsolveAuth.applyRoleUI) XsolveAuth.applyRoleUI(user);
    refresh();
  })();
})();
