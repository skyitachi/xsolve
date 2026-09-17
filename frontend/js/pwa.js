// PWA 引导：Service Worker 注册 + 安装入口 + iOS 引导
(function () {
  "use strict";

  // ---------- 1. 注册 Service Worker ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch(function (err) {
          console.warn("[pwa] SW 注册失败:", err && err.message);
        });
    });

    // 新 SW 接管后自动刷新一次，让用户拿到最新外壳
    var refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }

  // ---------- 2. 安装入口 ----------
  // 桌面：顶栏按钮 #install-app-btn；移动端：「设置」弹窗内 #install-app-mobile
  var deferredPrompt = null;
  var installBtns = [
    document.getElementById("install-app-btn"),
    document.getElementById("install-app-mobile"),
  ].filter(Boolean);

  function showInstallBtns() {
    installBtns.forEach(function (b) {
      b.hidden = false;
      b.style.display = "";
    });
  }
  function hideInstallBtns() {
    installBtns.forEach(function (b) {
      b.hidden = true;
      b.style.display = "none";
    });
  }

  async function doInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try {
        await deferredPrompt.userChoice;
      } catch (_) {}
      deferredPrompt = null;
      hideInstallBtns();
    } else {
      alert(
        "如果浏览器没有自动弹出安装框：\n\n" +
          "· iPhone/iPad：点底部分享按钮 →「添加到主屏幕」\n" +
          "· Android：点右上角菜单 →「安装应用 / 添加到主屏幕」",
      );
    }
  }

  installBtns.forEach(function (b) {
    b.addEventListener("click", doInstall);
  });

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBtns();
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    hideInstallBtns();
  });

  // ---------- 3. iOS 引导（Safari 不支持 beforeinstallprompt） ----------
  var ua = navigator.userAgent || "";
  var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  var isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;

  if (isIOS && !isStandalone) {
    // iOS 无法程序化安装，展示入口，点击后给出「分享 → 添加到主屏幕」指引
    showInstallBtns();
  }
})();
