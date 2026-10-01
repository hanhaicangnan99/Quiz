/* 侧栏形态判定（在 <head> 里最先执行，避免首屏闪一下）：
   - 自动：窄屏（≤1180px）或触屏设备（≤1440px）→ 抽屉模式（侧栏变浮层，题目满屏）
   - 手动：用户在侧栏底部点「切换为抽屉/并排显示」后记在本地，优先于自动判定
   实际效果是把 html.drawer-mode / html.side-mode 交给 app.css 控制。 */
(function () {
  "use strict";

  var KEY = "yxa:v1:drawerPref";   // "auto" | "drawer" | "side"

  function pref() {
    try {
      var v = window.localStorage.getItem(KEY);
      return (v === "drawer" || v === "side") ? v : "auto";
    } catch (e) {
      return "auto";
    }
  }

  function setPref(v) {
    try { window.localStorage.setItem(KEY, v); } catch (e) {}
  }

  function autoDrawer() {
    try {
      if (window.matchMedia("(max-width: 1180px), (max-width: 1440px) and (pointer: coarse)").matches) return true;
    } catch (e) {
      if (window.innerWidth <= 1180) return true;
    }
    return window.innerWidth <= 1180;
  }

  function apply() {
    var p = pref();
    var drawer = (p === "drawer") || (p === "auto" && autoDrawer());
    var root = document.documentElement;
    root.classList.toggle("drawer-mode", drawer);
    root.classList.toggle("side-mode", !drawer);
    return drawer;
  }

  window.YXA_LAYOUT = {
    pref: pref,
    setPref: setPref,
    autoDrawer: autoDrawer,
    apply: apply,
    reset: function () { setPref("auto"); return apply(); }
  };

  apply();
})();
