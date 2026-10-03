/* 运行时冒烟测试：用最小 DOM 桩加载真实的 app.js，验证启动、切库、出题、
   判分、错题流转与「重新打开后进度保留」等关键路径。
   用法（在 乙烯答题App 目录下）：node tools/smoke_test.mjs
   这是开发期自检工具，不参与扩展运行时。 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.dirname(HERE);

const failures = [];
const tick = () => new Promise((r) => setImmediate(r));   // 等待异步的同步码生成/解析
function check(cond, label, extra) {
  if (cond) { console.log(`  ok  ${label}`); return true; }
  failures.push(label + (extra ? ` → ${extra}` : ""));
  console.log(`  !!  ${label}${extra ? ` → ${extra}` : ""}`);
  return false;
}

/* ---------------------------------------------------------------- DOM 桩 */

function makeClassList(el) {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) set.add(c); else set.delete(c); },
    _set: set
  };
}

class El {
  constructor(id, tag) {
    this.id = id || "";
    this.tagName = (tag || "div").toUpperCase();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    this.classList = makeClassList(this);
    this._html = "";
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.files = [];
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, detail) {
    const ev = Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, detail || {});
    (this.listeners[type] || []).forEach((fn) => fn(ev));
    return ev;
  }
  appendChild(c) { this.children.push(c); return c; }
  removeChild() {}
  click() { this.dispatch("click"); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  scrollIntoView() {}
}

function makeRadio(name, value, state) {
  const listeners = {};
  return {
    name, value, listeners,
    get checked() { return state[name] === value; },
    set checked(on) { if (on) state[name] = value; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type) { (listeners[type] || []).forEach((fn) => fn({ target: this })); }
  };
}

function createDom(localStorageData) {
  const byId = new Map();
  const radioState = {};          // name -> 选中的 value
  const checkedByQid = {};        // qid -> [{value}]
  const store = localStorageData || new Map();

  const doc = {
    readyState: "complete",
    _listeners: {},
    documentElement: new El("html", "html"),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new El(id));
      return byId.get(id);
    },
    createElement(tag) { return new El("", tag); },
    addEventListener(type, fn) { (doc._listeners[type] = doc._listeners[type] || []).push(fn); },
    fire(type) { (doc._listeners[type] || []).forEach((fn) => fn({})); },
    querySelector(sel) {
      const m = /^input\[name="([^"]+)"\]:checked$/.exec(sel);
      if (m) {
        const name = m[1];
        if (radioState[name] === undefined) return null;
        return { value: radioState[name], checked: true, name };
      }
      return null;
    },
    querySelectorAll(sel) {
      let m = /^input\[name="([^"]+)"\](:checked)?$/.exec(sel);
      if (m) {
        const name = m[1];
        const values = name === "quizCount" ? ["30", "50", "100", "custom", "all"]
          : name === "orderMode" ? ["sequential", "random"]
            : [radioState[name]].filter(Boolean);
        return values.map((v) => makeRadio(name, v, radioState));
      }
      m = /^input\[data-qid="([^"]+)"\]:checked$/.exec(sel);
      if (m) return checkedByQid[m[1]] || [];
      return [];
    },
    body: new El("body", "body")
  };

  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    _store: store
  };

  const win = {
    document: doc,
    localStorage,
    CSS: { escape: (s) => String(s) },
    alert() {},
    confirm: () => true,
    scrollTo() {},
    setTimeout: (fn) => { fn(); return 0; },
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    atob: (b) => Buffer.from(String(b), "base64").toString("binary"),
    navigator: { userAgent: "smoke-test" },
    _listeners: {},
    addEventListener(type, fn) { (win._listeners[type] = win._listeners[type] || []).push(fn); },
    _fire(type, ev) { (win._listeners[type] || []).forEach((fn) => fn(ev || {})); }
  };
  win.window = win;
  return { doc, win, radioState, checkedByQid, store };
}

/* ---------------------------------------------------------------- 运行 app */

function bootApp(dom, scripts) {
  const sandbox = {
    window: dom.win,
    document: dom.doc,
    localStorage: dom.win.localStorage,
    CSS: dom.win.CSS,
    alert: dom.win.alert,
    confirm: dom.win.confirm,
    setTimeout: (fn) => { fn(); return 0; },
    console,
    Buffer,
    process,
    TextDecoder,
    TextEncoder,
    Blob: function () {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    FileReader: function () {}
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const rel of scripts) {
    vm.runInContext(fs.readFileSync(path.join(APP, rel), "utf8"), ctx, { filename: rel });
  }
  return ctx;
}

/* SheetJS 是纯 JS，可在 Node 里加载，用于真正验证导入解析路径。 */
class FakeFileReader {
  readAsArrayBuffer(file) { this.result = file._buffer; this.onload({ target: this }); }
  readAsText(file) { this.result = file._text; this.onload({ target: this }); }
}

function bootAppWithImport(dom) {
  const sandbox = {
    window: dom.win,
    document: dom.doc,
    localStorage: dom.win.localStorage,
    CSS: dom.win.CSS,
    alert: dom.win.alert,
    confirm: dom.win.confirm,
    setTimeout: (fn) => { fn(); return 0; },
    console,
    Buffer,
    process,
    TextDecoder,
    TextEncoder,
    Blob: function () {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    FileReader: FakeFileReader
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const rel of [...scripts, "vendor/xlsx.full.min.js"]) {
    vm.runInContext(fs.readFileSync(path.join(APP, rel), "utf8"), ctx, { filename: rel });
  }
  return ctx;
}

const bankFiles = ["banks/index.js", "banks/wf.js", "banks/cx.js", "banks/rd-zj.js", "banks/rd-gj.js", "banks/rd-js.js"];
const scripts = [...bankFiles, "app.js"];

/* ---------------------------------------------------------------- 测试 */

function lookup(bankId, qid) {
  const file = bankFiles.find((f) => f.endsWith(`/${bankId}.js`) || f.endsWith(`${bankId}.js`));
  const ctx = bootApp(createDom(new Map()), [file]);
  const bank = ctx.window.YXA.banks[0];
  return bank.questions.find((q) => q.id === qid);
}

function wrongAnswer(q) {
  if (q.type === "多选题") {
    const keys = q.options.map((o) => o.key);
    const right = new Set(String(q.answer).split(""));
    const first = keys.find((k) => right.has(k));
    return first ? [first] : [keys[0]];
  }
  if (/判断/.test(q.type)) return q.answer === "A" ? "B" : "A";
  const keys = q.options.map((o) => o.key);
  const right = new Set(String(q.answer).split(""));
  const bad = keys.find((k) => !right.has(k));
  return bad || "X";
}

function answerPaper(dom, bank, paperIds, rightCount) {
  paperIds.forEach((qid, i) => {
    const q = bank.questions.find((x) => x.id === qid);
    const asRight = i < rightCount;
    if (q.type === "多选题") {
      const vals = asRight ? String(q.answer).split("") : wrongAnswer(q);
      dom.checkedByQid[qid] = vals.map((v) => ({ value: v }));
      dom.doc.getElementById("content").dispatch("change", { target: { dataset: { qid } } });
    } else {
      const val = asRight ? q.answer : wrongAnswer(q);
      dom.doc.getElementById("content").dispatch("change", { target: { dataset: { qid }, value: val, type: "radio" } });
    }
  });
}

async function main() {
  console.log("1) 首次启动");
  let dom = createDom(new Map());
  bootApp(dom, scripts);

  const el = (id) => dom.doc.getElementById(id);
  check(el("bankSize").textContent === 814, "默认题库为危害因素（814 题）", String(el("bankSize").textContent));
  check(el("totalCount").textContent === 814, "题库总题数正确");
  check(el("undoneCount").textContent === 814, "初始全部为未做");
  check(/危害因素/.test(el("bankDesc").textContent), "题库说明已渲染");
  check(/optgroup/.test(el("bankSelect").innerHTML), "题库下拉按分组渲染");
  check(el("startQuizBtn").disabled === false, "开始出题按钮可用");

  console.log("2) 出题与判分（30 题，其中 12 题作答正确）");
  dom.radioState.quizScope = "all";
  dom.radioState.quizType = "all";
  dom.radioState.quizCount = "30";
  el("startQuizBtn").dispatch("click");
  const paperHtml = el("content").innerHTML;
  const paperIds = [...new Set([...paperHtml.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]))];
  check(paperIds.length === 30, "出题 30 题", String(paperIds.length));
  check(el("questionNavSection").style.display === "block", "题目导航已显示");

  const wfCtx = bootApp(createDom(new Map()), ["banks/index.js", "banks/wf.js"]);
  const wfBank = wfCtx.window.YXA.banks[0];
  answerPaper(dom, wfBank, paperIds, 12);
  check(el("questionNavSummary").textContent === "已完成 30 / 30", "答题状态记录完整", el("questionNavSummary").textContent);

  el("submitBtn").dispatch("click");
  check(/得分：<b>12<\/b> \/ 30/.test(el("scoreBox").innerHTML), "得分 12/30", el("scoreBox").innerHTML.slice(0, 60));
  check(el("correctCount").textContent === 12, "正确数 12", String(el("correctCount").textContent));
  check(el("wrongCount").textContent === 18, "错误数 18", String(el("wrongCount").textContent));
  check(el("undoneCount").textContent === 814 - 30, "未做数 784", String(el("undoneCount").textContent));

  console.log("3) 错题库视图");
  el("wrongTab").dispatch("click");
  const wrongHtml = el("content").innerHTML;
  check((wrongHtml.match(/class="question"/g) || []).length === 18, "错题库列出 18 题");
  el("paperTab").dispatch("click");

  console.log("4) 切换题库（进度互相独立）");
  el("bankSelect").value = "rd-js";
  el("bankSelect").dispatch("change");
  check(el("bankSize").textContent === 1325, "切到技师题库（1325 题）", String(el("bankSize").textContent));
  check(el("correctCount").textContent === 0, "技师题库进度独立为 0");
  check(el("wrongCount").textContent === 0, "技师题库错题独立为 0");
  check(dom.win.state === undefined && dom.win.els === undefined && dom.win.BANKS === undefined,
    "没有向 window 泄漏内部变量");
  const rsSubjectVisible = el("subjectField").style.display === "none";
  check(rsSubjectVisible, "技师题库不显示科目筛选");

  el("bankSelect").value = "cx";
  el("bankSelect").dispatch("change");
  check(el("subjectField").style.display === "", "程序文件题库显示科目筛选");
  check(/全部科目（306 题）/.test(el("subjectSelect").innerHTML), "科目下拉包含全部科目", el("subjectSelect").innerHTML.slice(0, 40));
  check((el("subjectSelect").innerHTML.match(/<option/g) || []).length === 23, "科目 22 个 + 全部");

  el("bankSelect").value = "wf";
  el("bankSelect").dispatch("change");
  check(el("correctCount").textContent === 12, "切回危害因素题库，正确数仍为 12", String(el("correctCount").textContent));
  check(el("wrongCount").textContent === 18, "切回危害因素题库，错题数仍为 18");
  check(el("subjectField").style.display === "none", "危害因素题库隐藏科目筛选");

  console.log("5) 清空错题库");
  el("clearWrongBtn").dispatch("click");
  check(el("wrongCount").textContent === 0, "错题数清零", String(el("wrongCount").textContent));
  check(el("undoneCount").textContent === 814 - 12, "错题回到未做（802）", String(el("undoneCount").textContent));

  console.log("6) 重新打开（复用同一份本地存储）");
  const store = dom.store;
  const before = [];
  for (const [k, v] of store) if (/ids|lastBank|settings/.test(k)) before.push(k);
  check(before.length >= 4, "已写入题库进度键 " + before.length + " 个");
  const dom2 = createDom(store);
  bootApp(dom2, scripts);
  const el2 = (id) => dom2.doc.getElementById(id);
  check(el2("bankSize").textContent === 814, "重开后回到上次的题库", String(el2("bankSize").textContent));
  check(el2("correctCount").textContent === 12, "重开后正确数保留 12", String(el2("correctCount").textContent));
  check(el2("undoneCount").textContent === 802, "重开后未做数保留 802", String(el2("undoneCount").textContent));
  check(dom2.radioState.quizCount === "30" || dom2.radioState.quizCount === undefined, "出题数量设置已恢复");

  console.log("7) 拼题规则");
  dom2.radioState.quizScope = "all";
  dom2.radioState.quizType = "判断题";
  dom2.radioState.quizCount = "10";
  el2("addRuleBtn").dispatch("click");
  check(/判断题/.test(el2("ruleList").innerHTML), "规则列表显示题型", el2("ruleList").innerHTML.slice(0, 80));
  el2("startQuizBtn").dispatch("click");
  const paper2 = [...new Set([...el2("content").innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]))];
  check(paper2.length === 10, "按规则出题 10 题", String(paper2.length));
  check(/拼题 1 条规则/.test(el2("paperSummary").textContent), "摘要显示拼题规则", el2("paperSummary").textContent);
  const allJudge = paper2.every((id) => /判断/.test(wfBank.questions.find((q) => q.id === id).type));
  check(allJudge, "拼题只包含判断题");

  console.log("8) 导入 xlsx / csv（真实 SheetJS 解析）");
  const xlsxPath = path.join(APP, "..", "乙烯装置操作工认定题库2022", "乙烯装置认定题库（初级）2022q.xlsx");
  const csvPath = path.join(APP, "..", "危害因素辨识与风险防控题库.csv");
  if (!fs.existsSync(xlsxPath) || !fs.existsSync(csvPath)) {
    console.log("  --  跳过：未找到上级目录里的样例题库文件（克隆仓库后属正常，导入逻辑由第 1~7 步与浏览器测试覆盖）");
  } else {
    const dom3 = createDom(new Map());
    bootAppWithImport(dom3);
    const el3 = (id) => dom3.doc.getElementById(id);

    const xlsxFile = { name: path.basename(xlsxPath), _buffer: fs.readFileSync(xlsxPath) };
    el3("importFile").files = [xlsxFile];
    el3("importFile").dispatch("change");
    check(/导入成功/.test(el3("importResult").textContent), "xlsx 导入成功", el3("importResult").textContent);
    const importedCount = Number(el3("bankSize").textContent);
    check(importedCount > 100, `xlsx 解析出题目（${importedCount} 题）`);
    check(/optgroup/.test(el3("bankSelect").innerHTML) && /导入：/.test(el3("bankSelect").innerHTML), "导入题库出现在列表中");
    check(el3("deleteBankBtn").style.display === "", "导入题库可删除");

    const csvFile = { name: path.basename(csvPath), _text: fs.readFileSync(csvPath, "utf8") };
    el3("importFile").files = [csvFile];
    el3("importFile").dispatch("change");
    check(/导入成功/.test(el3("importResult").textContent), "csv 导入成功", el3("importResult").textContent);
    check(Number(el3("bankSize").textContent) > 800, `csv 解析出题目（${el3("bankSize").textContent} 题）`);
    check(el3("subjectField").style.display === "", "csv 题库识别出科目列");

    const dom4 = createDom(dom3.store);
    bootApp(dom4, scripts);
    const el4 = (id) => dom4.doc.getElementById(id);
    check(/导入：/.test(el4("bankSelect").innerHTML), "重开后导入题库仍在列表里");

    el4("bankSelect").value = [...el4("bankSelect").innerHTML.matchAll(/value="(imp:[^"]+)"/g)][0][1];
    const deletedId = el4("bankSelect").value;
    el4("bankSelect").dispatch("change");
    const before = Number(el4("bankSize").textContent);
    check(before > 100, `重开后导入题库数据完整（${before} 题）`);
    el4("deleteBankBtn").dispatch("click");
    check(Number(el4("bankSize").textContent) === 814, "删除导入题库后回到内置题库", String(el4("bankSize").textContent));
    check(!el4("bankSelect").innerHTML.includes(deletedId), "被删除的题库已从列表移除");
    const dom5 = createDom(dom4.store);
    bootApp(dom5, scripts);
    check(!dom5.doc.getElementById("bankSelect").innerHTML.includes(deletedId), "删除后重开不再出现该导入题库");
  }

  console.log("9) 题目标记 / 标记题库 / 平板侧栏抽屉");
  const dom6 = createDom(dom.store);
  bootAppWithImport(dom6);
  const el6 = (id) => dom6.doc.getElementById(id);
  const body = dom6.doc.body;

  check(/标记题（0）/.test(el6("markedTab").textContent), "标记题页签显示 0", el6("markedTab").textContent);
  check(/标记试题（0）/.test(el6("scopeChoices").innerHTML), "练习模式含「标记试题」", "");

  dom6.radioState.quizScope = "all";
  dom6.radioState.quizType = "all";
  dom6.radioState.quizCount = "30";
  el6("startQuizBtn").click();
  let arts6 = el6("content").innerHTML;
  const markedIds = [...arts6.matchAll(/data-mark-qid="([^"]+)"/g)].map((m) => m[1]);
  check(markedIds.length === 30, "30 道题每题都有标记按钮", String(markedIds.length));
  check(/class="q-side"/.test(arts6) && /☆ 标记/.test(arts6), "标记按钮位于题型标签下方");

  // 事件委托：按选择器精确返回，模拟真实 DOM 的 closest 行为
  const clickMarkBtn = (id) => el6("content").dispatch("click", {
    target: { closest: (sel) => (sel === "[data-mark-qid]" ? { dataset: { markQid: id } } : null) }
  });
  const clickShowAnsBtn = () => el6("content").dispatch("click", {
    target: { closest: (sel) => (sel === '[data-action="toggle-answers"]' ? { dataset: {} } : null) }
  });

  // 标记 3 道题
  clickMarkBtn(markedIds[0]);
  clickMarkBtn(markedIds[1]);
  clickMarkBtn(markedIds[2]);
  check(/标记题（3）/.test(el6("markedTab").textContent), "标记 3 道后页签计数为 3", el6("markedTab").textContent);
  check(/标记试题（3）/.test(el6("scopeChoices").innerHTML), "练习模式计数同步为 3");

  // 再点一次取消第 3 道
  clickMarkBtn(markedIds[2]);
  check(/标记题（2）/.test(el6("markedTab").textContent), "再次点击可取消标记", el6("markedTab").textContent);

  el6("markedTab").dispatch("click");
  let markedHtml = el6("content").innerHTML;
  check((markedHtml.match(/class="question/g) || []).length === 2, "标记题列表显示 2 题");
  check(/取消标记/.test(markedHtml), "标记题列表带取消标记按钮");
  check(/标记题：2 题/.test(el6("paperSummary").textContent), "摘要显示标记题数量", el6("paperSummary").textContent);

  // 在标记题页签内取消一条
  clickMarkBtn(markedIds[0]);
  check(/标记题（1）/.test(el6("markedTab").textContent), "在标记题列表内可直接取消", el6("markedTab").textContent);

  // 用「标记试题」范围出题
  el6("paperTab").dispatch("click");
  dom6.radioState.quizScope = "marked";
  dom6.radioState.quizType = "all";
  dom6.radioState.quizCount = "all";
  el6("startQuizBtn").click();
  const markedPaper = [...new Set([...el6("content").innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]))];
  check(markedPaper.length === 1, "按「标记试题」出题只出标记过的题", String(markedPaper.length));
  check(markedPaper[0] === markedIds[1], "出的正是被标记的那道题");

  // 标记持久化
  const dom7 = createDom(dom6.store);
  bootApp(dom7, scripts);
  const el7 = (id) => dom7.doc.getElementById(id);
  check(/标记题（1）/.test(el7("markedTab").textContent), "重开后标记仍在", el7("markedTab").textContent);
  el7("clearMarkBtn").dispatch("click");
  check(/标记题（0）/.test(el7("markedTab").textContent), "清空标记生效", el7("markedTab").textContent);

  // 侧栏抽屉（开合状态挂在 <html> 上，CSS 依赖 html.drawer-mode.drawer-open）
  const uiRoot = dom6.doc.documentElement;
  check(uiRoot.classList.contains("drawer-open") === false, "抽屉默认收起");
  el6("drawerBtn").dispatch("click");
  check(uiRoot.classList.contains("drawer-open") === true, "点小按钮可呼出侧栏（类加在 html 上）");
  el6("drawerBackdrop").dispatch("click");
  check(uiRoot.classList.contains("drawer-open") === false, "点遮罩收起侧栏");
  el6("drawerBtn").dispatch("click");
  el6("drawerCloseBtn").dispatch("click");
  check(uiRoot.classList.contains("drawer-open") === false, "点关闭键收起侧栏");
  el6("drawerBtn").dispatch("click");
  el6("startQuizBtn").click();
  check(uiRoot.classList.contains("drawer-open") === false, "开始出题后自动收起侧栏（不挤压题目）");

  console.log("10) 错题库/标记题的答案显示（标绿 + 侧栏开关）");
  dom6.radioState.quizScope = "all";
  dom6.radioState.quizType = "all";
  dom6.radioState.quizCount = "custom";
  el6("customCount").value = "3";
  el6("startQuizBtn").click();
  const wrongPaper = [...new Set([...el6("content").innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]))];
  check(wrongPaper.length === 3, "重新出 3 题", String(wrongPaper.length));
  answerPaper(dom6, wfBank, wrongPaper, 0);   // 3 题全答错
  el6("submitBtn").click();
  check(/错题库（3）/.test(el6("wrongTab").textContent), "产生 3 道错题", el6("wrongTab").textContent);

  el6("wrongTab").dispatch("click");
  let listHtml = el6("content").innerHTML;
  check(!/correct-highlight/.test(listHtml), "默认不显示答案：选项无绿色标记");
  check(!/正确答案：/.test(listHtml), "默认不显示答案：无正确答案文本");
  check(!/list-hint|点这里显示/.test(listHtml), "★ 隐藏时不再出现任何提示条");
  check(/答案已隐藏/.test(el6("paperSummary").textContent), "摘要标明答案已隐藏", el6("paperSummary").textContent);

  // 抽屉形态下浮动的「显示答案」按钮
  check(el6("answerToggleBtn").textContent === "显示答案", "浮动按钮默认是「显示答案」", el6("answerToggleBtn").textContent);
  el6("answerToggleBtn").dispatch("click");
  check(el6("showAnswerToggle").checked === true, "★ 浮动按钮可打开显示答案");
  check(el6("answerToggleBtn").textContent === "隐藏答案", "按钮文案变为「隐藏答案」", el6("answerToggleBtn").textContent);
  check(el6("answerToggleBtn").classList.contains("on"), "浮动按钮带上 on 高亮");
  listHtml = el6("content").innerHTML;
  check(/correct-highlight/.test(listHtml), "显示答案后正确选项标绿");
  check(!/正确答案：/.test(listHtml), "★ 选择题不再出现「正确答案：X」文字栏（由绿色选项表示）");
  check(!/result show answer/.test(listHtml), "★ 无解析时不显示多余的文字栏");

  el6("answerToggleBtn").dispatch("click");
  check(el6("showAnswerToggle").checked === false, "再点浮动按钮可隐藏答案");
  check(el6("answerToggleBtn").textContent === "显示答案", "按钮文案切回「显示答案」");
  listHtml = el6("content").innerHTML;
  check(!/correct-highlight/.test(listHtml), "浮动按钮可再隐藏答案");
  check(!/正确答案：/.test(listHtml), "隐藏时不残留答案文本");

  // 标记题列表同样受该开关控制
  el6("showAnswerToggle").checked = true;
  el6("showAnswerToggle").dispatch("change");
  el6("markedTab").dispatch("click");
  const markedHtml2 = el6("content").innerHTML;
  check(/correct-highlight/.test(markedHtml2), "标记题列表也标绿正确选项");
  check(!/正确答案：/.test(markedHtml2), "标记题列表也不出现「正确答案：」文字栏");

  console.log("10b) 有解析的题只放解析；无选项的主观题仍显示正确答案");
  const csvWithExp = "题型,题干,答案,选项A,选项B,选项C,选项D,解析\n" +
    "单选题,解析栏测试题,B,甲,乙,丙,丁,这里是解析内容。\n" +
    "简答题,主观题测试题,参考答案文本,,,,\n";
  const dom8 = createDom(new Map());
  bootAppWithImport(dom8);
  const el8 = (id) => dom8.doc.getElementById(id);
  el8("importFile").files = [{ name: "_exp_test.csv", _text: csvWithExp }];
  el8("importFile").dispatch("change");
  check(/导入成功/.test(el8("importResult").textContent), "导入「1 道选择题 + 1 道简答题」的小题库", el8("importResult").textContent);
  dom8.radioState.quizScope = "all";
  dom8.radioState.quizType = "all";
  dom8.radioState.quizCount = "all";
  el8("startQuizBtn").click();
  el8("showAnswerToggle").checked = true;
  el8("showAnswerToggle").dispatch("change");
  const fakeBank = { questions: [
    { id: "0001", type: "单选题", answer: "B", options: [{ key: "A", text: "甲" }] },
    { id: "0002", type: "简答题", answer: "参考答案文本", options: [] }
  ] };
  const beforeSubmitHtml = el8("content").innerHTML;
  check(/correct-highlight/.test(beforeSubmitHtml), "未提交时「显示答案」会标绿正确选项");
  check(/details class="explain"/.test(beforeSubmitHtml), "★ 未提交时「显示答案」也会给出解析（与答案绑定）");
  el8("showAnswerToggle").checked = false;
  el8("showAnswerToggle").dispatch("change");
  const hiddenHtml = el8("content").innerHTML;
  check(!/correct-highlight/.test(hiddenHtml), "关掉开关后选项不再标绿");
  check(!/details class="explain"/.test(hiddenHtml), "★ 关掉开关后解析也一起隐藏（防透题）");
  check(!/这里是解析内容。/.test(hiddenHtml), "★ 解析正文完全不出现");
  el8("showAnswerToggle").checked = true;
  el8("showAnswerToggle").dispatch("change");
  answerPaper(dom8, fakeBank, ["0001", "0002"], 0);   // 两道都答错
  el8("submitBtn").click();
  check(/details class="explain"/.test(el8("content").innerHTML), "提交判分后结果里也带解析");
  check(/错题库（2）/.test(el8("wrongTab").textContent), "两道题进入错题库", el8("wrongTab").textContent);
  el8("wrongTab").dispatch("click");
  const expHtml = el8("content").innerHTML;
  check(/这里是解析内容。/.test(expHtml), "★ 解析内容出现在列表里");
  check(/details class="explain"/.test(expHtml), "★ 解析用可折叠的 details 包裹");
  check(!/details class="explain" open/.test(expHtml), "★ 解析默认是折叠的（不占版面）");
  check(!/正确答案：B/.test(expHtml), "★ 选择题不出现「正确答案：B」");
  check(/正确答案：参考答案文本/.test(expHtml), "★ 无选项的简答题仍用文字给出正确答案");
  check(/correct-highlight/.test(expHtml), "带解析的题同样标绿正确选项");

  console.log("11) 侧栏形态：自动判定 + 手动切换");
  const root = { classList: makeClassList(null) };
  dom6.doc.documentElement = root;
  // 桩里没有 layout.js（head 脚本），这里装一个同样语义的实现
  dom6.win.YXA_LAYOUT = {
    _pref: "auto",
    pref() { return this._pref; },
    setPref(v) { this._pref = v; },
    autoDrawer() { return true; },
    apply() {
      const drawer = this._pref === "drawer" || (this._pref === "auto" && this.autoDrawer());
      root.classList.toggle("drawer-mode", drawer);
      root.classList.toggle("side-mode", !drawer);
      return drawer;
    }
  };
  dom6.win.YXA_LAYOUT.apply();
  check(root.classList.contains("drawer-mode"), "自动判定为抽屉模式");

  el6("modeToggleBtn").dispatch("click");       // 自动(抽屉) → 手动并排
  check(dom6.win.YXA_LAYOUT.pref() === "side", "点切换后记住「并排」选择", dom6.win.YXA_LAYOUT.pref());
  check(root.classList.contains("side-mode"), "切换后 html 上是并排形态");
  check(/手动·并排/.test(el6("layoutStatus").textContent), "状态行标明当前是手动·并排", el6("layoutStatus").textContent);

  el6("modeToggleBtn").dispatch("click");       // 手动并排 → 抽屉
  check(dom6.win.YXA_LAYOUT.pref() === "drawer", "再点切回抽屉", dom6.win.YXA_LAYOUT.pref());
  check(root.classList.contains("drawer-mode"), "切回后 html 上是抽屉形态");
  check(/切换为并排显示/.test(el6("modeToggleBtn").textContent), "按钮文案随模式变化", el6("modeToggleBtn").textContent);
  check(/^v2\.2/.test(el6("layoutStatus").textContent), "状态行带版本号 v2.2", el6("layoutStatus").textContent);

  console.log("12) 多设备同步：同步码往返与并集合并");
  const dom9 = createDom(new Map());          // 全新设备 A
  bootAppWithImport(dom9);
  const el9 = (id) => dom9.doc.getElementById(id);
  const clickMark9 = () => {
    const m = /data-mark-qid="([^"]+)"/.exec(el9("content").innerHTML);
    if (m) {
      dom9.doc.getElementById("content").dispatch("click", {
        target: { closest: (sel) => (sel === "[data-mark-qid]" ? { dataset: { markQid: m[1] } } : null) }
      });
    }
  };
  dom9.radioState.quizScope = "all";
  dom9.radioState.quizType = "all";
  dom9.radioState.quizCount = "custom";
  el9("customCount").value = "5";
  el9("startQuizBtn").click();
  const ids9 = [...new Set([...el9("content").innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]))];
  check(ids9.length === 5, "出 5 题准备同步", String(ids9.length));
  answerPaper(dom9, wfBank, ids9, 3);              // 前 3 对、后 2 错
  el9("submitBtn").click();
  clickMark9();
  check(el9("correctCount").textContent === 3 && el9("wrongCount").textContent === 2, "同步前：3 对 2 错",
    `${el9("correctCount").textContent}/${el9("wrongCount").textContent}`);
  check(/标记题（1）/.test(el9("markedTab").textContent), "同步前：1 道标记", el9("markedTab").textContent);

  el9("genCodeBtn").dispatch("click");
  await tick();
  const code = el9("syncCode").value;
  check(/^YXA1-/.test(code), "同步码带 YXA1- 前缀", String(code).slice(0, 14));
  check(code.length > 100, `同步码非空（${code.length} 字符）`);
  check(/已生成 \d+ 字符/.test(el9("syncResult").textContent), "生成后给出提示", el9("syncResult").textContent);

  // 模拟「另一台手机」：全新存储 + 全新页面
  const dom10 = createDom(new Map());
  bootAppWithImport(dom10);
  const el10 = (id) => dom10.doc.getElementById(id);
  check(el10("correctCount").textContent === 0, "另一台设备初始为空");
  el10("syncCode").value = code;
  el10("mergeImportBtn").dispatch("click");
  await tick();
  check(el10("correctCount").textContent === 3, "★ 另一台导入后拿到 3 道正确", String(el10("correctCount").textContent));
  check(el10("wrongCount").textContent === 2, "★ 另一台导入后拿到 2 道错题", String(el10("wrongCount").textContent));
  check(/标记题（1）/.test(el10("markedTab").textContent), "★ 标记也同步过去了", el10("markedTab").textContent);
  check(/已合并导入 5 个题库/.test(el10("syncResult").textContent), "导入结果提示完整", el10("syncResult").textContent);

  // 反向同步：另一台新增记录后把码发回来 → 取并集，谁的都不丢
  dom10.radioState.quizScope = "all";
  dom10.radioState.quizType = "all";
  dom10.radioState.quizCount = "custom";
  el10("customCount").value = "4";
  el10("startQuizBtn").click();
  const ids10 = [...new Set([...el10("content").innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]))];
  answerPaper(dom10, wfBank, ids10, 4);            // 4 题全对
  el10("submitBtn").click();
  const theirCorrect = Number(el10("correctCount").textContent);
  el10("genCodeBtn").dispatch("click");
  await tick();
  el9("syncCode").value = el10("syncCode").value;
  el9("mergeImportBtn").dispatch("click");
  await tick();
  check(Number(el9("correctCount").textContent) >= 3, "★ 并集合并：本机正确数不减少",
    String(el9("correctCount").textContent));
  check(Number(el9("correctCount").textContent) >= theirCorrect - 1, "★ 并集合并：对方的记录也进来了",
    `${el9("correctCount").textContent} vs ${theirCorrect}`);
  check(el9("wrongCount").textContent === 2, "★ 并集合并：本机原有 2 道错题仍在", String(el9("wrongCount").textContent));

  el9("syncCode").value = "随便一段文字";
  el9("mergeImportBtn").dispatch("click");
  await tick();
  check(/不是本 App 的同步码/.test(el9("syncResult").textContent), "★ 粘错内容会明确报错", el9("syncResult").textContent);

  console.log("13) 自己写解析（我的解析）：渲染 / 同步 / 新旧合并");
  const storeA = new Map();
  storeA.set("yxa:v1:bank:wf:notes", JSON.stringify({ "0001": { t: "A 设备的解析", u: 1000 } }));
  const domA = createDom(storeA);
  bootAppWithImport(domA);
  const elA = (id) => domA.doc.getElementById(id);
  domA.radioState.quizScope = "all";
  domA.radioState.quizType = "all";
  domA.radioState.quizCount = "30";
  elA("startQuizBtn").click();
  const paperA = [...new Set([...elA("content").innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]))];
  check(paperA.indexOf("0001") >= 0, "顺序出题的卷子里包含题号 0001");
  check(/我的解析/.test(elA("content").innerHTML) && /A 设备的解析/.test(elA("content").innerHTML),
    "★ 我写的解析显示在题卡上");
  check(/✎ 我的解析/.test(elA("content").innerHTML), "有解析时按钮变成「✎ 我的解析」");
  check(/✎ 解析/.test(elA("content").innerHTML), "没写解析的题仍显示「✎ 解析」");
  check(/class="note-wrap"/.test(elA("content").innerHTML), "每道题都带我写的解析区域");

  elA("genCodeBtn").dispatch("click");
  await tick();
  const codeA = elA("syncCode").value;
  check(/我的解析 1/.test(elA("syncResult").textContent), "★ 同步码统计里包含我写的解析", elA("syncResult").textContent);

  // 设备 B：同题已有一条更旧的解析
  const storeB = new Map();
  storeB.set("yxa:v1:bank:wf:notes", JSON.stringify({ "0001": { t: "B 设备的旧解析", u: 500 } }));
  const domB = createDom(storeB);
  bootAppWithImport(domB);
  const elB = (id) => domB.doc.getElementById(id);
  elB("syncCode").value = codeA;
  elB("mergeImportBtn").dispatch("click");
  await tick();
  const notesB = JSON.parse(storeB.get("yxa:v1:bank:wf:notes") || "{}");
  check(notesB["0001"] && notesB["0001"].t === "A 设备的解析",
    "★ 较新的解析覆盖较旧的", JSON.stringify(notesB["0001"]));

  // 手造一段「更旧」的同步码导入 A：A 的新解析不能被冲掉
  const olderPayload = {
    v: 1, app: "yxa", at: "2020-01-01T00:00:00Z",
    banks: { wf: { c: [], w: [], u: [], m: [], n: { "0001": { t: "更旧的解析", u: 1 } } } }
  };
  const olderCode = "YXA1-raw" + Buffer.from(JSON.stringify(olderPayload), "utf8").toString("base64");
  elA("syncCode").value = olderCode;
  elA("mergeImportBtn").dispatch("click");
  await tick();
  const notesA = JSON.parse(storeA.get("yxa:v1:bank:wf:notes") || "{}");
  check(notesA["0001"] && notesA["0001"].t === "A 设备的解析",
    "★ 导入更旧的解析不会把新的冲掉", JSON.stringify(notesA["0001"]));
  check(Object.keys(notesA).length === 1, "★ 合并后不会重复堆叠", JSON.stringify(Object.keys(notesA)));

  // 清空我的解析
  elA("clearNoteBtn").dispatch("click");
  check(Object.keys(JSON.parse(storeA.get("yxa:v1:bank:wf:notes") || "{}")).length === 0,
    "★ 「清空我的解析」清掉全部笔记", storeA.get("yxa:v1:bank:wf:notes"));

  console.log("");
  if (failures.length) {
    console.log(`冒烟测试失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  !! ${f}`);
    process.exit(1);
  }
  console.log("冒烟测试全部通过。");
  return 0;
}

main().then((code) => process.exit(code));
