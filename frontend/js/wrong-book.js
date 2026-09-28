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
    onlyPending: false,
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
  function renderMath(el) {
    if (!el || typeof window.renderMathInElement !== 'function') return;
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
    } catch (e) { /* 保持原样 */ }
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
    if (!S.bookId) { S.items = []; renderList(); return Promise.resolve(); }
    var q = '/api/wrong-book/items?bookId=' + encodeURIComponent(S.bookId)
      + (S.onlyPending ? '&status=pending' : '');
    return j(q).then(function (data) {
      S.items = data.items || [];
      renderList();
    });
  }

  function refresh() {
    return loadBooks().then(loadItems).catch(function (e) {
      toast(e.message || '加载失败');
    });
  }

  // ========== 渲染 ==========

  function renderStats() {
    var st = S.stats || { pending: 0, mastered: 0, total: 0 };
    $('#st-pending').textContent = st.pending || 0;
    $('#st-mastered').textContent = st.mastered || 0;
    $('#st-total').textContent = st.total || 0;
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

  function renderList() {
    var el = $('#wb-list');
    if (!S.items.length) {
      el.innerHTML = '';
      $('#wb-empty').hidden = false;
      $('#wb-empty').querySelector('div:nth-child(2)').textContent =
        S.onlyPending ? '没有待复习的题了' : '这个错题本还是空的';
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
        + (mastered ? '<span class="tag" style="background:#e6f7ef;color:#2f9e6e;">已掌握</span>' : '')
        + (it.problem_exists === false ? '<span class="tag warn">题目已删除</span>' : '')
        + '</div>'
        + '<div class="txt">' + esc(it.text || '（题面缺失）') + '</div>'
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

  function fmtDate(ts) {
    if (!ts) return '-';
    var d = new Date(ts * 1000);
    return (d.getMonth() + 1) + '/' + d.getDate();
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
      html += '<div class="meta" style="margin-top:12px;font-size:12px;color:#9a9aab;">'
        + '错 ' + (it.wrong_count || 0) + ' 次 · 重做 ' + (it.review_count || 0) + ' 次'
        + ' · 来源：' + esc(SRC_LABEL[it.source] || it.source || '-')
        + '</div>';
      $('#dt-body').innerHTML = html;

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

  function redoItem(id, problemId) {
    // 记一次重做动作（P1 的掌握度判定会用；现在只是让「重做几次」可见）
    j('/api/wrong-book/items/' + encodeURIComponent(id) + '/review', { method: 'POST' })
      .catch(function () { /* 记不上不影响重做 */ });
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

  $('#wb-filter-btn').addEventListener('click', function () {
    S.onlyPending = !S.onlyPending;
    this.textContent = S.onlyPending ? '🔍 显示全部' : '🔍 只看待复习';
    this.classList.toggle('btn-primary', S.onlyPending);
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
    var id = this.getAttribute('data-id');
    var pid = S.detail && S.detail.item ? S.detail.item.problem_id : null;
    if (!pid) { toast('这道题的原题已被删除，无法重做'); return; }
    redoItem(id, pid);
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
