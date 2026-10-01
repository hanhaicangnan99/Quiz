/* 网页版（GitHub Pages 等）的 PWA 支持：
   - 在 https/http 下注册 Service Worker，实现离线可用；
   - 支持「安装到桌面 / 手机」提示。
   扩展页（chrome-extension://）与本地 file:// 会自动跳过，不影响侧载使用。 */
(function () {
  "use strict";

  var isWeb = location.protocol === "https:" || location.protocol === "http:";
  if (!isWeb) return;

  var btn = document.getElementById("installBtn");
  var deferred = null;

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    if (btn) btn.style.display = "";
  });

  if (btn) {
    btn.addEventListener("click", function () {
      if (!deferred) return;
      deferred.prompt();
      if (deferred.userChoice && deferred.userChoice.then) {
        deferred.userChoice.then(function () {
          deferred = null;
          btn.style.display = "none";
        });
      } else {
        deferred = null;
        btn.style.display = "none";
      }
    });
  }

  window.addEventListener("appinstalled", function () {
    if (btn) btn.style.display = "none";
  });

  if (!("serviceWorker" in navigator)) return;

  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;

  navigator.serviceWorker.register("sw.js").then(function () {
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (hadController && !reloading) {
        reloading = true;
        location.reload();
      }
    });
  }).catch(function (err) {
    try { console.warn("Service Worker 注册失败，离线缓存不可用：", err); } catch (e) {}
  });
})();
