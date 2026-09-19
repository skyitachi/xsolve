// 统一鉴权包装（用户系统 P0 + P1/P2）
//   - 所有 /api 请求自动带 Cookie（同源 fetch 默认 same-origin，已含 Cookie）
//   - 401 → 跳登录页（带 next 回跳）；403 → 提示无权限
//   - 提供当前用户、账户菜单（改密 / 我的孩子 / 账号管理）、按角色裁剪 UI
(function () {
  "use strict";

  var LOGIN_PAGE = "/login.html";
  // 仅管理员可见的页面
  var ADMIN_PAGES = ["/eval.html", "/student-eval.html", "/prompts.html", "/settings.html", "/accounts.html"];
  // 仅家长（与管理员）可见的页面
  var PARENT_PAGES = ["/my-children.html"];

  var _me = null;
  var _redirecting = false;

  function redirectToLogin() {
    if (_redirecting) return;
    _redirecting = true;
    var next = encodeURIComponent(location.pathname + location.search);
    location.replace(LOGIN_PAGE + "?next=" + next);
  }

  // ---------- 请求包装 ----------

  function isAuthEndpoint(url) {
    return /\/api\/auth\/(login|register)$/.test(url);
  }

  /**
   * 统一 fetch：带 Cookie、401 跳登录、403 抛错（便于调用方提示）。
   */
  function api(url, opts) {
    var o = Object.assign({ credentials: "include" }, opts || {});
    o.headers = Object.assign({}, (opts && opts.headers) || {});
    if (o.body && typeof o.body === "string" && !o.headers["content-type"]) {
      o.headers["content-type"] = "application/json";
    }
    return fetch(url, o).then(function (resp) {
      if (resp.status === 401 && !isAuthEndpoint(url)) {
        redirectToLogin();
        throw new Error("未登录");
      }
      return resp;
    });
  }

  /**
   * 兜底：老代码里直接 fetch('/api/...') 的 401 也能触发跳转。
   * 只做「观察」，不改请求语义。
   */
  function installFetchGuard() {
    if (window.__xsolveFetchGuard) return;
    window.__xsolveFetchGuard = true;
    var orig = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var p = orig.apply(this, arguments);
      if (!/^\/api\//.test(url) || isAuthEndpoint(url)) return p;
      return p.then(function (resp) {
        if (resp.status === 401) redirectToLogin();
        return resp;
      });
    };
  }

  // ---------- 当前用户 ----------

  function guard() {
    if (_me) return Promise.resolve(_me);
    return fetch("/api/auth/me", { credentials: "include" })
      .then(function (resp) {
        if (!resp.ok) { redirectToLogin(); return null; }
        return resp.json().then(function (data) {
          _me = data.user;
          if (typeof state !== "undefined") state.userId = _me.id;
          return _me;
        });
      })
      .catch(function () {
        // 网络异常不跳转，交给后续请求报错
        return null;
      });
  }

  function me() { return _me; }

  function logout() {
    return fetch("/api/auth/logout", { method: "POST", credentials: "include" })
      .catch(function () {})
      .then(function () { location.replace(LOGIN_PAGE); });
  }

  /** 家长当前查看的孩子 id（默认第一个绑定的孩子） */
  function viewStudentId() {
    var stored = null;
    try { stored = localStorage.getItem("xsolve_view_student"); } catch (e) { /* ignore */ }
    var kids = (_me && _me.children) || [];
    if (stored && kids.some(function (c) { return c.id === stored; })) return stored;
    return kids.length ? kids[0].id : null;
  }

  function setViewStudentId(id) {
    try {
      if (id) localStorage.setItem("xsolve_view_student", id);
      else localStorage.removeItem("xsolve_view_student");
    } catch (e) { /* ignore */ }
  }

  // ---------- 按角色裁剪 UI ----------

  function hideAdminLinks(root) {
    hideLinks(root, ADMIN_PAGES);
  }

  /** 隐藏指向指定页面的顶栏入口 / 弹窗导航项 */
  function hideLinks(root, pages) {
    var nodes = (root || document).querySelectorAll(
      ".topbar-admin, .topbar-parent, .dialog-admin-nav a"
    );
    Array.prototype.forEach.call(nodes, function (a) {
      var href = a.getAttribute("href") || "";
      if (pages.indexOf(href) >= 0) a.style.display = "none";
    });
  }

  function applyRoleUI(user) {
    if (!user) return;
    // 非管理员：隐藏管理页入口（后端还有 403 兜底）
    if (!user.is_admin) hideAdminLinks(document);
    // 非家长：隐藏「我的孩子」入口（管理员可保留，便于协助排查）
    if (user.role !== "parent" && !user.is_admin) {
      hideLinks(document, PARENT_PAGES);
    } else {
      // 家长/管理员：显示默认隐藏的家长入口
      Array.prototype.forEach.call(document.querySelectorAll(".topbar-parent"), function (a) {
        a.hidden = false;
        a.style.display = "";
      });
    }

    if (user.role === "student") {
      // 学生账号：锁死学生模式，隐藏模式切换
      var sw = document.querySelector(".mode-switch");
      if (sw) sw.style.display = "none";
      if (typeof setModeUI === "function" && typeof state !== "undefined") {
        setModeUI("student");
      }
    }

    if (user.role === "parent") {
      // 家长：模式固定为家长版（后端强制派生），隐藏到「学生版」的切换以免误导
      var sw2 = document.querySelector(".mode-switch");
      if (sw2) sw2.style.display = "none";
    }

    if (user.is_guest) showGuestBanner(user);

    renderAccountButton(user);
  }

  /** 游客顶部提示条（一次性插入，不干扰原有布局） */
  function showGuestBanner(user) {
    if (document.getElementById("guest-banner")) return;
    var bar = document.createElement("div");
    bar.id = "guest-banner";
    bar.setAttribute("style", [
      "position:sticky;top:0;z-index:60;display:flex;gap:8px;align-items:center;flex-wrap:wrap",
      "padding:6px 10px;font-size:12.5px;background:#fff7ed;color:#9a3412;border-bottom:1px solid #fed7aa",
    ].join(";"));
    bar.innerHTML =
      "<span>🧪 游客试用中" + (guestRemaining(user) ? "（" + guestRemaining(user) + "，到期后数据会自动清理）" : "") + "</span>" +
      '<a href="/login.html" style="margin-left:auto;color:#9a3412;font-weight:600;">注册正式账号 →</a>';
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // ---------- 账户按钮 + 弹窗 ----------

  function labelOf(user) {
    return user.display_name || user.username || "账户";
  }

  function roleText(user) {
    if (user.role === "parent") return "家长";
    if (user.role === "admin") return "管理员";
    return "学生";
  }

  function ensureDialog() {
    var dlg = document.getElementById("account-dialog");
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.id = "account-dialog";
    dlg.innerHTML = [
      '<h3>👤 我的账户</h3>',
      '<p class="muted" id="account-who"></p>',
      '<p class="muted" id="account-guest" hidden></p>',
      '<div id="account-children" hidden>',
      '  <label for="account-child-select" style="font-size:13px;display:block;margin-bottom:4px;">查看的孩子：</label>',
      '  <select id="account-child-select" style="width:100%;padding:6px;"></select>',
      '  <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">',
      '    <button type="button" id="account-invite-btn">➕ 邀请码（孩子注册用）</button>',
      '    <button type="button" id="account-bindcode-btn">🔗 绑定码（给另一位家长）</button>',
      '  </div>',
      '  <p class="muted" id="account-invite-out" hidden></p>',
      '</div>',
      '<nav class="dialog-admin-nav" id="account-nav"></nav>',
      '<details id="account-pw-box">',
      '  <summary>🔒 修改密码</summary>',
      '  <label for="account-old-pw" style="font-size:13px;display:block;margin:8px 0 4px;">原密码</label>',
      '  <input id="account-old-pw" type="password" autocomplete="current-password" style="width:100%;padding:8px;font-size:16px;" />',
      '  <label for="account-new-pw" style="font-size:13px;display:block;margin:8px 0 4px;">新密码（至少 6 位）</label>',
      '  <input id="account-new-pw" type="password" autocomplete="new-password" style="width:100%;padding:8px;font-size:16px;" />',
      '  <button type="button" id="account-pw-submit" style="margin-top:8px;">提交修改</button>',
      '  <p class="muted" id="account-pw-out" hidden></p>',
      '</details>',
      '<menu>',
      '  <button type="button" id="account-logout">退出登录</button>',
      '  <button value="ok">关闭</button>',
      '</menu>'
    ].join("\n");
    document.body.appendChild(dlg);

    dlg.querySelector("#account-logout").addEventListener("click", function () { logout(); });

    // 邀请码（孩子注册）
    dlg.querySelector("#account-invite-btn").addEventListener("click", function () {
      var out = dlg.querySelector("#account-invite-out");
      out.hidden = false;
      out.textContent = "生成中…";
      api("/api/auth/invite", { method: "POST" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { out.textContent = "失败：" + d.error; return; }
          out.textContent = "邀请码：" + d.code + "（7 天内有效，让孩子注册时填写）";
        })
        .catch(function (e) { out.textContent = "失败：" + e.message; });
    });

    // 绑定码（多家长绑定同一个孩子）
    dlg.querySelector("#account-bindcode-btn").addEventListener("click", function () {
      var out = dlg.querySelector("#account-invite-out");
      var sel = dlg.querySelector("#account-child-select");
      var sid = sel && sel.value;
      out.hidden = false;
      out.textContent = "生成中…";
      api("/api/family/bind-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ studentId: sid || undefined }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { out.textContent = "失败：" + d.error; return; }
          out.textContent = "绑定码：" + d.code + "（7 天内有效，让另一位家长在「我的孩子」页填码绑定）";
        })
        .catch(function (e) { out.textContent = "失败：" + e.message; });
    });

    // 改密
    dlg.querySelector("#account-pw-submit").addEventListener("click", function () {
      var out = dlg.querySelector("#account-pw-out");
      var oldPw = dlg.querySelector("#account-old-pw").value;
      var newPw = dlg.querySelector("#account-new-pw").value;
      if (!oldPw || !newPw) { out.hidden = false; out.textContent = "请填写原密码与新密码"; return; }
      out.hidden = false;
      out.textContent = "提交中…";
      api("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { out.textContent = "失败：" + (res.d.error || "未知错误"); return; }
          out.textContent = "已修改。其它设备的登录已失效。";
          dlg.querySelector("#account-old-pw").value = "";
          dlg.querySelector("#account-new-pw").value = "";
        })
        .catch(function (e) { out.textContent = "失败：" + e.message; });
    });

    var sel = dlg.querySelector("#account-child-select");
    sel.addEventListener("change", function () {
      setViewStudentId(sel.value);
      location.reload();
    });
    return dlg;
  }

  /** 游客剩余试用时长文案（如「剩余约 3 小时」） */
  function guestRemaining(user) {
    if (!user || !user.guest_expires_at) return "";
    var ms = user.guest_expires_at * 1000 - Date.now();
    if (ms <= 0) return "已到期";
    var hours = Math.floor(ms / 3600000);
    var mins = Math.floor((ms % 3600000) / 60000);
    return hours > 0 ? ("剩余约 " + hours + " 小时") : ("剩余约 " + mins + " 分钟");
  }

  /** 账户弹窗里的游客提示 */
  function guestHint(user) {
    if (!user || !user.is_guest) return "";
    var left = guestRemaining(user);
    return "🧪 游客试用中" + (left ? "（" + left + "，到期后数据会自动清理）" : "") +
      " · 注册正式账号可长期保存学习记录";
  }

  function renderAccountButton(user) {
    var host = document.querySelector(".topbar-actions") || document.querySelector(".topbar-actions-host");
    if (!host) return;
    var btn = document.getElementById("account-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "account-btn";
      btn.title = "账户";
      host.appendChild(btn);
      btn.addEventListener("click", function () {
        var dlg = ensureDialog();
        var u = me() || user;
        dlg.querySelector("#account-who").textContent =
          labelOf(u) + "（" + roleText(u) + (u.username ? " · " + u.username : "") + "）";

        var guestBox = dlg.querySelector("#account-guest");
        var gh = guestHint(u);
        guestBox.hidden = !gh;
        guestBox.textContent = gh;

        // 家长：孩子下拉 + 邀请码 / 绑定码
        var kidsBox = dlg.querySelector("#account-children");
        var sel = dlg.querySelector("#account-child-select");
        var kids = u.children || [];
        if (u.role === "parent") {
          kidsBox.hidden = false;
          sel.innerHTML = kids.length
            ? kids.map(function (c) {
                var name = (c.display_name || c.username) + (c.relation ? "（" + c.relation + "）" : "");
                return '<option value="' + c.id + '">' + name + "</option>";
              }).join("")
            : '<option value="">（尚未绑定孩子）</option>';
          sel.value = viewStudentId() || "";
          sel.disabled = kids.length === 0;
          dlg.querySelector("#account-invite-btn").hidden = false;
          dlg.querySelector("#account-bindcode-btn").hidden = kids.length === 0;
        } else {
          kidsBox.hidden = true;
        }

        // 账户菜单里的页面入口
        var nav = dlg.querySelector("#account-nav");
        var links = ['<a href="/student-memory.html">🧠 学习档案</a>'];
        if (u.is_guest) {
          links.unshift('<a href="/login.html">📝 注册正式账号（保留长期记录）</a>');
        }
        if (u.role === "parent") {
          links.unshift('<a href="/my-children.html">👨‍👩‍👧 我的孩子</a>');
        }
        if (u.is_admin) {
          links.push('<a href="/accounts.html">🗂 账号管理</a>');
          links.push('<a href="/eval.html">📊 评估面板</a>');
          links.push('<a href="/prompts.html">📝 Prompt 管理</a>');
          links.push('<a href="/settings.html">🔑 模型配置</a>');
        }
        nav.innerHTML = links.join("");

        // 游客账号没有可用的旧密码（随机生成），隐藏改密
        dlg.querySelector("#account-pw-box").hidden = !!u.is_guest;

        if (typeof dlg.showModal === "function") dlg.showModal();
        else dlg.setAttribute("open", "");
      });
    }
    btn.textContent = "👤 " + labelOf(user);
    btn.style.fontSize = "13px";
  }

  // ---------- 对外暴露 ----------

  window.XsolveAuth = {
    api: api,
    guard: guard,
    me: me,
    logout: logout,
    viewStudentId: viewStudentId,
    setViewStudentId: setViewStudentId,
    applyRoleUI: applyRoleUI,
    redirectToLogin: redirectToLogin,
    // 启动时即解析登录态；app.js 可 await 本 Promise
    ready: null,
  };

  installFetchGuard();
  window.XsolveAuth.ready = guard().then(function (user) {
    if (user) applyRoleUI(user);
    return user;
  });
})();
