/* 真实浏览器回归测试：在 Chrome 里加载 index.html（注入临时探针），
   用「计算后的样式」验证那些 DOM 桩测不出来的东西：
   - 抽屉按钮点开后侧栏是否真的滑出来了（transform）、遮罩是否真的出现
   - 抽屉/并排两种形态下 aside 的定位、题目是否满屏
   - 标记按钮、错题库标绿、答案开关的实际样式
   用法（在 乙烯答题App 目录下）：node tools/browser_test.mjs
   会自动查找 Chrome / Edge，任何一个都行。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.dirname(HERE);

const failures = [];
function check(cond, label, extra) {
  if (cond) { console.log(`  ok  ${label}`); return true; }
  failures.push(label + (extra ? ` → ${extra}` : ""));
  console.log(`  !!  ${label}${extra ? ` → ${extra}` : ""}`);
  return false;
}

/* ---------------------------------------------------------------- 找浏览器 */

function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

/* ---------------------------------------------------------------- 探针 */

const PROBE = String.raw`
window.addEventListener("load", function () {
  var log = [], err = "";
  function q(id) { return document.getElementById(id); }
  function cs(el, prop) { return getComputedStyle(el).getPropertyValue(prop); }
  function aside() { return document.querySelector("aside"); }
  function root() { return document.documentElement; }
  function app() { return document.querySelector(".app"); }
  var asideEl = aside();
  asideEl.style.transition = "none";     // 跳过动画，直接读最终样式
  try {
    log.push("vw=" + window.innerWidth);
    log.push("mode=" + (root().classList.contains("drawer-mode") ? "drawer" : "side"));
    log.push("asidePos=" + cs(asideEl, "position"));
    log.push("asideW=" + Math.round(asideEl.getBoundingClientRect().width));
    log.push("asideTx=" + Math.round(asideEl.getBoundingClientRect().left));
    log.push("fabDisplay=" + cs(q("drawerBtn"), "display"));
    log.push("backdrop=" + cs(q("drawerBackdrop"), "display"));
    log.push("paperW=" + Math.round(q("content").getBoundingClientRect().width));

    // 点「☰ 侧栏」→ 应该滑出来
    q("drawerBtn").click();
    log.push("openFlag=" + root().classList.contains("drawer-open"));
    log.push("openTx=" + Math.round(asideEl.getBoundingClientRect().left));
    log.push("openBackdrop=" + cs(q("drawerBackdrop"), "display"));
    log.push("openAsideVisible=" + (asideEl.getBoundingClientRect().left >= -2 ? "yes" : "no"));

    // 点遮罩 → 应该收起
    q("drawerBackdrop").click();
    log.push("closedFlag=" + root().classList.contains("drawer-open"));
    log.push("closedTx=" + Math.round(asideEl.getBoundingClientRect().left));

    // 出题 → 标记 / 提交 / 错题库标绿
    root().classList.add("drawer-open");   // 让侧栏（含开始出题按钮）可点
    q("startQuizBtn").click();
    log.push("paper=" + document.querySelectorAll("#content article.question").length);
    var markBtn = document.querySelector("#content [data-mark-qid]");
    markBtn.click();
    log.push("markBtnText=" + markBtn.textContent);
    log.push("markBtnClass=" + markBtn.className);
    log.push("cardMarked=" + /marked/.test(markBtn.closest(".question").className));
    log.push("navMarked=" + document.querySelectorAll("#questionNavList .q-nav-item.marked").length);
    log.push("tabText=" + q("markedTab").textContent);
    log.push("navWidth=" + Math.round(document.querySelector("#questionNavList").getBoundingClientRect().width));
    log.push("contentW=" + Math.round(q("content").getBoundingClientRect().width));
    log.push("statusLine=" + q("layoutStatus").textContent);
  } catch (e) {
    err = "PROBE-ERROR:" + (e && e.message ? e.message : e);
  }
  document.title = "BTEST|" + log.join("|") + (err ? "|" + err : "");
});
`;

/* ---------------------------------------------------------------- 运行一次 */

function runOnce(browser, size) {
  const app = APP;
  const pagePath = path.join(app, "_btest_page.html");
  const probePath = path.join(app, "_btest_probe.js");
  const html = fs.readFileSync(path.join(app, "index.html"), "utf8")
    .replace("</body>", '  <script src="_btest_probe.js"></script>\n</body>');
  fs.writeFileSync(pagePath, html, "utf8");
  fs.writeFileSync(probePath, PROBE, "utf8");

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "yxa-btest-"));
  const out = path.join(profile, "dom.txt");
  const url = "file:///" + pagePath.replace(/\\/g, "/");
  const args = [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--allow-file-access-from-files", "--hide-scrollbars",
    "--user-data-dir=" + profile, "--window-size=" + size,
    "--virtual-time-budget=10000", "--dump-dom", url
  ];
  try {
    const dom = execFileSync(browser, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    const m = /<title>(BTEST\|[^<]*)<\/title>/.exec(dom);
    return m ? m[1].split("|").slice(1) : ["NO-TITLE"];
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(pagePath, { force: true });
    fs.rmSync(probePath, { force: true });
  }
}

function value(log, key) {
  const hit = log.find((l) => l.startsWith(key + "="));
  return hit ? hit.slice(key.length + 1) : "";
}

/* ---------------------------------------------------------------- 主流程 */

const browser = findBrowser();
if (!browser) {
  console.log("跳过：本机没有找到 Chrome/Edge，无法做真实浏览器测试。");
  process.exit(0);
}
console.log(`浏览器：${browser}`);

console.log("\n1) 平板宽度 820×1180（应自动进入抽屉形态）");
const narrow = runOnce(browser, "820,1180");
if (narrow[0] === "NO-TITLE") {
  check(false, "探针成功执行", narrow.join(" "));
} else {
  check(value(narrow, "mode") === "drawer", "自动判定为抽屉形态", value(narrow, "mode"));
  check(value(narrow, "asidePos") === "fixed", "侧栏脱离文档流（不再挤占题目）", value(narrow, "asidePos"));
  check(Number(value(narrow, "asideTx")) < -50, "未点按钮时侧栏在屏幕外", `left=${value(narrow, "asideTx")}`);
  check(value(narrow, "fabDisplay") !== "none", "☰ 侧栏按钮可见", value(narrow, "fabDisplay"));
  check(value(narrow, "backdrop") === "none", "遮罩默认隐藏");

  check(value(narrow, "openFlag") === "true", "点按钮后 html 上出现 drawer-open");
  check(Number(value(narrow, "openTx")) >= -2, "★ 侧栏真的滑出来了", `left=${value(narrow, "openTx")}`);
  check(value(narrow, "openAsideVisible") === "yes", "★ 侧栏可见（起点在屏幕内）");
  check(value(narrow, "openBackdrop") !== "none", "★ 遮罩出现了（背景变暗）", value(narrow, "openBackdrop"));
  check(value(narrow, "closedFlag") === "false", "点遮罩可收起", value(narrow, "closedFlag"));
  check(Number(value(narrow, "closedTx")) < -50, "收起后侧栏又回到屏幕外", `left=${value(narrow, "closedTx")}`);
  check(Number(value(narrow, "paperW")) > Number(value(narrow, "asideW")) * 2,
    "题目区宽度不受侧栏挤压", `paper=${value(narrow, "paperW")} aside=${value(narrow, "asideW")}`);

  check(Number(value(narrow, "paper")) === 30, "出题 30 题", value(narrow, "paper"));
  check(value(narrow, "markBtnText") === "★ 已标记", "点标记按钮后文字变为已标记", value(narrow, "markBtnText"));
  check(/mark-btn on/.test(value(narrow, "markBtnClass")), "标记按钮带 on 样式", value(narrow, "markBtnClass"));
  check(value(narrow, "cardMarked") === "true", "题卡加上 marked 描边", value(narrow, "cardMarked"));
  check(Number(value(narrow, "navMarked")) === 1, "题号导航出现 ★", value(narrow, "navMarked"));
  check(/标记题（1）/.test(value(narrow, "tabText")), "标记题页签计数更新", value(narrow, "tabText"));
  check(Number(value(narrow, "navWidth")) > 100, "抽屉里题目导航可见且有宽度", value(narrow, "navWidth"));
  check(/^v1\.6/.test(value(narrow, "statusLine")), "状态行显示 v1.6", value(narrow, "statusLine"));
  check(!/PROBE-ERROR/.test(narrow.join("|")), "探针无异常", narrow.filter((l) => /ERROR/.test(l)).join(" "));
}

console.log("\n2) 桌面宽度 1500×950（应自动进入并排形态）");
const wide = runOnce(browser, "1500,950");
if (wide[0] === "NO-TITLE") {
  check(false, "探针成功执行", wide.join(" "));
} else {
  check(value(wide, "mode") === "side", "自动判定为并排形态", value(wide, "mode"));
  check(value(wide, "asidePos") !== "fixed", "侧栏在文档流里（并排）", value(wide, "asidePos"));
  check(Number(value(wide, "asideTx")) >= 0, "侧栏就在左边", `left=${value(wide, "asideTx")}`);
  check(value(wide, "fabDisplay") === "none", "并排形态下不显示 ☰ 悬浮按钮", value(wide, "fabDisplay"));
  check(Number(value(wide, "contentW")) > 600, "题目区宽度正常", value(wide, "contentW"));
  check(!/PROBE-ERROR/.test(wide.join("|")), "探针无异常", wide.filter((l) => /ERROR/.test(l)).join(" "));
}

console.log("");
if (failures.length) {
  console.log(`真实浏览器测试失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  !! ${f}`);
  process.exit(1);
}
console.log("真实浏览器测试全部通过。");
