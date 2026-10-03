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

    // 浮动「显示答案」按钮：应在「☰ 侧栏」上方、互不重叠，且能开/关答案
    var ansBtn = q("answerToggleBtn");
    var drawerBtnEl = q("drawerBtn");
    var ansRect = ansBtn.getBoundingClientRect();
    var drawRect = drawerBtnEl.getBoundingClientRect();
    log.push("ansBtnDisplay=" + cs(ansBtn, "display"));
    log.push("ansBtnAbove=" + (ansRect.bottom <= drawRect.top + 1 ? "yes" : "no"));
    log.push("ansBtnLabel=" + ansBtn.textContent);
    ansBtn.style.transition = "none";     // 跳过 0.15s 颜色过渡，直接读最终色
    ansBtn.click();
    log.push("ansBtnLabelAfter=" + ansBtn.textContent);
    log.push("ansBtnOnAfter=" + ansBtn.classList.contains("on"));
    log.push("ansBtnOnBg=" + cs(ansBtn, "background-color"));
    ansBtn.click();
    log.push("ansBtnLabelBack=" + ansBtn.textContent);

    // 出题 → 标记 / 提交 / 错题库标绿
    root().classList.add("drawer-open");   // 让侧栏（含开始出题按钮）可点
    q("startQuizBtn").click();
    log.push("paper=" + document.querySelectorAll("#content article.question").length);

    // 有题目之后再验证浮动按钮真的能把答案标绿 / 取消标绿
    ansBtn.click();
    log.push("greenAfterToggle=" + (document.querySelectorAll("#content .option.correct-highlight").length > 0));
    ansBtn.click();
    log.push("greenAfterToggleOff=" + (document.querySelectorAll("#content .option.correct-highlight").length > 0));

    // —— 解析折叠 + 切换显示答案时不让当前题目位移 ——
    // 换到「程序文件题库 → 联锁保护系统管理规定」：35 题里确定有 8 题带解析
    var bankSel = q("bankSelect");
    bankSel.value = "cx";
    bankSel.dispatchEvent(new Event("change", { bubbles: true }));
    var subj = q("subjectSelect");
    for (var si = 0; si < subj.options.length; si++) {
      if (/联锁保护系统管理规定/.test(subj.options[si].text)) { subj.value = subj.options[si].value; break; }
    }
    subj.dispatchEvent(new Event("change", { bubbles: true }));
    q("showAnswerToggle").checked = true;          // 解析只在「显示答案」打开时才出现
    q("showAnswerToggle").dispatchEvent(new Event("change", { bubbles: true }));
    var countAll = document.querySelector('input[name="quizCount"][value="all"]');
    if (countAll) countAll.checked = true;
    q("startQuizBtn").click();
    var cards = document.querySelectorAll("#content article.question");
    log.push("cxPaper=" + cards.length);
    log.push("explainCount=" + document.querySelectorAll("#content .explain").length);
    var explains = document.querySelectorAll("#content .explain");
    var openCount = 0, totalH = 0;
    for (var ei = 0; ei < explains.length; ei++) {
      if (explains[ei].open) openCount++;
      totalH += explains[ei].getBoundingClientRect().height;
    }
    log.push("explainOpenCount=" + openCount);
    log.push("explainTotalH=" + Math.round(totalH));
    log.push("explainPillH=" + Math.round(explains[0] ? explains[0].getBoundingClientRect().height : 0));

    var firstSummary = document.querySelector("#content .explain > summary");
    if (firstSummary) {
      firstSummary.click();
      log.push("explainOpenHeight=" + Math.round(document.querySelector("#content .explain-body").offsetHeight));
      firstSummary.click();
    }

    // 关掉「显示答案」：解析与绿色答案都应消失（做题不透题）；再打开应全部回来
    q("showAnswerToggle").checked = false;
    q("showAnswerToggle").dispatchEvent(new Event("change", { bubbles: true }));
    log.push("offExplain=" + document.querySelectorAll("#content .explain").length);
    log.push("offGreen=" + document.querySelectorAll("#content .option.correct-highlight").length);
    q("showAnswerToggle").checked = true;
    q("showAnswerToggle").dispatchEvent(new Event("change", { bubbles: true }));
    log.push("onExplainBack=" + document.querySelectorAll("#content .explain").length);

    // 把最后一道带解析的题滚到视口顶部，然后关掉「显示答案」，看它是否还在原位
    // （关闭时上面 7 道题的解析胶囊会消失，不补偿的话它会上移约 260px）
    var explainCards = document.querySelectorAll("#content article.question");
    var anchorCard = null;
    for (var ci = explainCards.length - 1; ci >= 0; ci--) {
      if (explainCards[ci].querySelector(".explain")) { anchorCard = explainCards[ci]; break; }
    }
    if (anchorCard) {
      anchorCard.scrollIntoView({ block: "center" });   // 让这道题落在视口正中（app 以正中那题作为锚点）
      var anchorId = anchorCard.dataset.id;
      var topBefore = Math.round(document.querySelector('.question[data-id="' + anchorId + '"]').getBoundingClientRect().top);
      q("showAnswerToggle").checked = false;
      q("showAnswerToggle").dispatchEvent(new Event("change", { bubbles: true }));
      var topAfter = Math.round(document.querySelector('.question[data-id="' + anchorId + '"]').getBoundingClientRect().top);
      log.push("anchorShift=" + (topAfter - topBefore));
      log.push("greenGone=" + (document.querySelectorAll("#content .option.correct-highlight").length === 0));
      // 打开时应重新标绿
      q("showAnswerToggle").checked = true;
      q("showAnswerToggle").dispatchEvent(new Event("change", { bubbles: true }));
      log.push("paperHasGreen=" + (document.querySelectorAll("#content .option.correct-highlight").length > 0));
    }

    // 判分之后：结果框保留「正确答案 + 解析」，再切换显示答案也不会丢、更不会出现两份
    q("submitBtn").click();
    q("showAnswerToggle").checked = false;
    q("showAnswerToggle").dispatchEvent(new Event("change", { bubbles: true }));
    q("showAnswerToggle").checked = true;
    q("showAnswerToggle").dispatchEvent(new Event("change", { bubbles: true }));
    var resBox = document.querySelector("#content .result.show");
    log.push("resultKept=" + (resBox && /正确答案/.test(resBox.textContent) ? "yes" : "no"));
    var allCards = document.querySelectorAll("#content article.question");
    var firstExplained = null;
    for (var xi = 0; xi < allCards.length; xi++) {
      if (allCards[xi].querySelector(".explain")) { firstExplained = allCards[xi]; break; }
    }
    log.push("submitExplainCount=" + document.querySelectorAll("#content .explain").length);
    log.push("explainPerCard=" + (firstExplained ? firstExplained.querySelectorAll(".explain").length : -1));
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

    // —— 我写的解析：真实 DOM 里点按钮 → 输入 → 保存 ——
    var noteCard = document.querySelector("#content article.question");
    var noteId = noteCard.dataset.id;
    var noteBtn = noteCard.querySelector("[data-note-edit]");
    log.push("noteBtnText=" + (noteBtn ? noteBtn.textContent : "none"));
    noteBtn.click();
    var input = document.querySelector('[data-note-wrap="' + noteId + '"] .note-input');
    log.push("noteEditorOpen=" + !!input);
    if (input) {
      input.value = "我自己写的解析：先看题干问的是“不是”，再排除。";
      document.querySelector('[data-note-save="' + noteId + '"]').click();
      var body = document.querySelector('[data-note-wrap="' + noteId + '"] .note-body');
      log.push("noteSavedText=" + (body ? body.textContent.slice(0, 16) : "none"));
      log.push("noteBtnAfter=" + document.querySelector('[data-note-edit="' + noteId + '"]').textContent);
      var bankNow = "wf";
      try { bankNow = JSON.parse(localStorage.getItem("yxa:v1:lastBank")) || "wf"; } catch (e) {}
      log.push("noteInStorage=" + ((JSON.parse(localStorage.getItem("yxa:v1:bank:" + bankNow + ":notes") || "{}")[noteId] || {}).t ? "yes" : "no"));
      // 切一次「显示答案」，确认重新渲染后我写的解析还在
      var tgl = q("showAnswerToggle");
      tgl.checked = !tgl.checked;
      tgl.dispatchEvent(new Event("change", { bubbles: true }));
      var body2 = document.querySelector('[data-note-wrap="' + noteId + '"] .note-body');
      log.push("noteSurvivesRerender=" + (body2 && /我自己写的解析/.test(body2.textContent) ? "yes" : "no"));
    }

    // —— 同步码：真实 gzip 压缩 → 解压导入（异步，故放到最后） ——
    window.confirm = function () { return true; };   // headless 里 confirm 默认返回 false
    q("genCodeBtn").click();
    setTimeout(function () {
      try {
        var code = q("syncCode").value;
        log.push("syncCodeKind=" + String(code).slice(0, 8));
        log.push("syncCodeLen=" + code.length);
        log.push("syncNotice=" + String(q("syncResult").textContent).slice(0, 12));
        log.push("correctBefore=" + q("correctCount").textContent);
        q("mergeImportBtn").click();
        setTimeout(function () {
          try {
            log.push("mergeNotice=" + String(q("syncResult").textContent).slice(0, 14));
            log.push("correctAfter=" + q("correctCount").textContent);
            log.push("markedAfter=" + q("markedTab").textContent);
          } catch (e2) { err = "SYNC-ERROR:" + (e2 && e2.message ? e2.message : e2); }
          finish();
        }, 400);
      } catch (e1) {
        err = "SYNC-ERROR:" + (e1 && e1.message ? e1.message : e1);
        finish();
      }
    }, 600);
  } catch (e) {
    err = "PROBE-ERROR:" + (e && e.message ? e.message : e);
    finish();
  }

  function finish() {
    document.title = "BTEST|" + log.join("|") + (err ? "|" + err : "");
  }
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
  check(value(narrow, "ansBtnDisplay") !== "none", "浮动「显示答案」按钮可见", value(narrow, "ansBtnDisplay"));
  check(value(narrow, "ansBtnAbove") === "yes", "★ 显示答案按钮在「☰ 侧栏」上方且不重叠");
  check(value(narrow, "ansBtnLabel") === "显示答案", "浮动按钮默认是「显示答案」", value(narrow, "ansBtnLabel"));
  check(value(narrow, "ansBtnLabelAfter") === "隐藏答案", "点一下变成「隐藏答案」", value(narrow, "ansBtnLabelAfter"));
  check(value(narrow, "ansBtnOnAfter") === "true", "浮动按钮带 on 高亮", value(narrow, "ansBtnOnAfter"));
  check(value(narrow, "ansBtnOnBg").replace(/\s/g, "") === "rgb(20,108,148)",
    "★ 高亮时底色是主题蓝（不是被过渡卡住的白色）", value(narrow, "ansBtnOnBg"));
  check(value(narrow, "greenAfterToggle") === "true", "★ 浮动按钮点了题目正确选项真的标绿", value(narrow, "greenAfterToggle"));
  check(value(narrow, "greenAfterToggleOff") === "false", "再点一下绿色消失", value(narrow, "greenAfterToggleOff"));
  check(value(narrow, "ansBtnLabelBack") === "显示答案", "按钮文案切回「显示答案」", value(narrow, "ansBtnLabelBack"));

  check(Number(value(narrow, "cxPaper")) === 35, "切到「联锁保护系统管理规定」出 35 题", value(narrow, "cxPaper"));
  check(Number(value(narrow, "explainCount")) === 8, "其中 8 题带解析（确定性样本）", value(narrow, "explainCount"));
  check(Number(value(narrow, "explainOpenCount")) === 0, "★ 解析默认全部折叠（没有一个是展开的）", value(narrow, "explainOpenCount"));
  check(Number(value(narrow, "explainPillH")) > 0 && Number(value(narrow, "explainPillH")) < 45,
    "★ 折叠时「解析」胶囊很矮（<45px），不占版面", value(narrow, "explainPillH"));
  check(Number(value(narrow, "explainTotalH")) < 8 * 45,
    "★ 8 个解析加起来的高度远小于展开时的正文高度", value(narrow, "explainTotalH"));
  check(Number(value(narrow, "explainOpenHeight")) > 20, "点开后解析能正常展开", value(narrow, "explainOpenHeight"));
  check(Math.abs(Number(value(narrow, "anchorShift"))) <= 3,
    "★ 切换显示答案时，当前题目纹丝不动（锚点位移 ≤3px）", `shift=${value(narrow, "anchorShift")}px`);
  check(value(narrow, "paperHasGreen") === "true", "切换后答案确实标绿了", value(narrow, "paperHasGreen"));
  check(Number(value(narrow, "offExplain")) === 0, "★ 关掉「显示答案」后解析一个都不剩（不会透题）", value(narrow, "offExplain"));
  check(Number(value(narrow, "offGreen")) === 0, "★ 关掉后正确选项也不再标绿", value(narrow, "offGreen"));
  check(Number(value(narrow, "onExplainBack")) === 8, "★ 再打开解析又全部回来（与答案绑定）", value(narrow, "onExplainBack"));
  check(value(narrow, "resultKept") === "yes", "★ 判分后再切换显示答案，判分结果不丢", value(narrow, "resultKept"));
  check(Number(value(narrow, "submitExplainCount")) === 8, "判分后解析仍在（在结果框里）", value(narrow, "submitExplainCount"));
  check(Number(value(narrow, "explainPerCard")) === 1, "★ 每道题只出现一份解析，不重复", value(narrow, "explainPerCard"));
  check(/^YXA1-gz-/.test(value(narrow, "syncCodeKind")),
    "★ 同步码用真实 gzip 压缩（不是降级路径）", value(narrow, "syncCodeKind"));  check(Number(value(narrow, "syncCodeLen")) > 100 && Number(value(narrow, "syncCodeLen")) < 12000,
    "★ 同步码长度合理（几千字符）", value(narrow, "syncCodeLen"));
  check(/已生成/.test(value(narrow, "syncNotice")), "生成后给出提示", value(narrow, "syncNotice"));
  check(/已合并导入/.test(value(narrow, "mergeNotice")), "★ 解压导入成功", value(narrow, "mergeNotice"));
  check(value(narrow, "correctAfter") === value(narrow, "correctBefore"),
    "★ 导入自己的记录是幂等的（取并集，数字不变）",
    `${value(narrow, "correctBefore")} → ${value(narrow, "correctAfter")}`);
  check(/标记题（1）/.test(value(narrow, "markedAfter")), "★ 导入后标记数量正确", value(narrow, "markedAfter"));

  check(value(narrow, "noteBtnText") === "✎ 解析", "题卡上有「✎ 解析」按钮", value(narrow, "noteBtnText"));
  check(value(narrow, "noteEditorOpen") === "true", "★ 点按钮打开编辑框");
  check(/我自己写的解析/.test(value(narrow, "noteSavedText")), "★ 保存后题卡上出现我写的解析", value(narrow, "noteSavedText"));
  check(value(narrow, "noteBtnAfter") === "✎ 我的解析", "按钮变为「✎ 我的解析」", value(narrow, "noteBtnAfter"));
  check(value(narrow, "noteInStorage") === "yes", "★ 我写的解析已落盘", value(narrow, "noteInStorage"));
  check(value(narrow, "noteSurvivesRerender") === "yes", "★ 切换显示答案重绘后我写的解析仍在", value(narrow, "noteSurvivesRerender"));
  check(Number(value(narrow, "paperW")) > Number(value(narrow, "asideW")) * 2,
    "题目区宽度不受侧栏挤压", `paper=${value(narrow, "paperW")} aside=${value(narrow, "asideW")}`);

  check(Number(value(narrow, "paper")) === 30, "出题 30 题", value(narrow, "paper"));
  check(value(narrow, "markBtnText") === "★ 已标记", "点标记按钮后文字变为已标记", value(narrow, "markBtnText"));
  check(/mark-btn on/.test(value(narrow, "markBtnClass")), "标记按钮带 on 样式", value(narrow, "markBtnClass"));
  check(value(narrow, "cardMarked") === "true", "题卡加上 marked 描边", value(narrow, "cardMarked"));
  check(Number(value(narrow, "navMarked")) === 1, "题号导航出现 ★", value(narrow, "navMarked"));
  check(/标记题（1）/.test(value(narrow, "tabText")), "标记题页签计数更新", value(narrow, "tabText"));
  check(Number(value(narrow, "navWidth")) > 100, "抽屉里题目导航可见且有宽度", value(narrow, "navWidth"));
  check(/^v2\.2/.test(value(narrow, "statusLine")), "状态行显示 v2.2", value(narrow, "statusLine"));
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
