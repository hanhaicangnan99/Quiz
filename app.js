/* 乙烯答题练习（Chrome 侧载版）
   由原「离线答题系统」的 5 个单文件合并而来：
   - 一份界面与判分逻辑，服务多个题库，可在侧栏自由切换；
   - 每个题库的正确/错误/未做记录、出题设置互相独立并分别保存；
   - 保留 xlsx/xls/csv 导入（生成新的题库条目，不覆盖内置题库）。
   说明：全部脚本外置，不使用内联脚本与远程资源，满足扩展页 CSP 与离线要求。 */
(function () {
  "use strict";

  /* ============================================================ 常量 */

  var YXA = window.YXA || { banks: [] };
  var ORDER = YXA.ORDER || [];
  var META = YXA.META || {};

  var PREFIX = "yxa:v1:";
  var KEY_LAST = "lastBank";
  var KEY_IMPORTED = "importedBanks";
  var GROUP_IMPORTED = "导入题库";
  var APP_VERSION = "1.5";

  var TYPE_ORDER = ["单选题", "多选题", "判断题", "填空题", "简答题", "计算题", "论述题"];

  /* ============================================================ 存储层 */

  var storageWarned = false;

  function lsGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(PREFIX + key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch (e) {
      if (!storageWarned) {
        storageWarned = true;
        window.alert("本地存储写入失败，本次记录可能无法保存。\n原因：" + (e && e.message ? e.message : e));
      }
      return false;
    }
  }

  function lsDel(key) {
    try { window.localStorage.removeItem(PREFIX + key); } catch (e) {}
  }

  function bankKey(id, suffix) { return "bank:" + id + ":" + suffix; }

  /* ============================================================ 题库注册 */

  var BANKS = {};      // id -> 题库对象
  var BANK_LIST = [];  // 显示顺序
  var runtime = {};    // id -> 该题库的练习状态
  var state = null;    // 当前题库的练习状态

  function registerBuiltins() {
    (YXA.banks || []).forEach(function (b) {
      if (!b || !b.id || !b.questions || !b.questions.length) return;
      BANKS[b.id] = {
        id: b.id, name: b.name, group: b.group || "题库", desc: b.desc || "",
        source: b.source || "", builtAt: b.builtAt || "", questions: b.questions, builtin: true
      };
    });
  }

  function loadImported() {
    var list = lsGet(KEY_IMPORTED, []) || [];
    list.forEach(function (meta) {
      if (!meta || !meta.id || BANKS[meta.id]) return;
      var qs = lsGet(bankKey(meta.id, "questions"), null);
      if (!qs || !qs.length) return;
      BANKS[meta.id] = {
        id: meta.id, name: meta.name, group: GROUP_IMPORTED,
        desc: "由文件 " + (meta.file || "") + " 导入", source: meta.file || "",
        builtAt: meta.builtAt || "", questions: qs, builtin: false
      };
    });
  }

  function saveImportedRegistry() {
    var list = Object.keys(BANKS).filter(function (id) { return !BANKS[id].builtin; })
      .map(function (id) {
        var b = BANKS[id];
        return { id: b.id, name: b.name, file: b.source, count: b.questions.length, builtAt: b.builtAt };
      });
    lsSet(KEY_IMPORTED, list);
  }

  function buildBankList() {
    var ids = [], seen = {};
    ORDER.forEach(function (id) { if (BANKS[id] && !seen[id]) { seen[id] = 1; ids.push(id); } });
    Object.keys(BANKS).forEach(function (id) { if (!seen[id]) { seen[id] = 1; ids.push(id); } });
    BANK_LIST = ids.map(function (id) { return BANKS[id]; });
  }

  /* ============================================================ 状态 */

  function createState(bank) {
    return {
      bankId: bank.id,
      bank: bank.questions,
      correct: [], wrong: [], undone: [], marked: [], markedSet: {},
      paper: [], answers: {},
      mode: "quiz", showAnswers: false, submitted: false,
      currentScope: "all", currentType: "all", currentSubject: "all", currentOrder: "sequential",
      quizRules: [],
      savedCount: "30", savedCustom: 30,
      loaded: false
    };
  }

  function idsOf(list) { return list.map(function (q) { return q.id; }); }

  function persistIds(st) {
    if (!st || !st.loaded) return;
    lsSet(bankKey(st.bankId, "ids"), {
      c: idsOf(st.correct), w: idsOf(st.wrong), u: idsOf(st.undone), m: idsOf(st.marked)
    });
  }

  function rebuildMarkedSet(st) {
    st.markedSet = {};
    st.marked.forEach(function (q) { st.markedSet[q.id] = 1; });
  }

  function reconcile(st) {
    var saved = lsGet(bankKey(st.bankId, "ids"), {}) || {};
    var cid = {}, wid = {}, uid = {}, mid = {}, seen = {};
    (saved.c || []).forEach(function (id) { cid[id] = 1; });
    (saved.w || []).forEach(function (id) { wid[id] = 1; });
    (saved.u || []).forEach(function (id) { uid[id] = 1; });
    (saved.m || []).forEach(function (id) { mid[id] = 1; });
    st.correct = []; st.wrong = []; st.undone = []; st.marked = [];
    st.bank.forEach(function (q) {
      if (seen[q.id]) return;   // 同一题库内重复 id 只统计一次
      seen[q.id] = 1;
      if (mid[q.id]) st.marked.push(q);      // 标记是独立标签，与对错状态并存
      if (wid[q.id]) st.wrong.push(q);
      else if (cid[q.id]) st.correct.push(q);
      else st.undone.push(q);
    });
    rebuildMarkedSet(st);
    st.loaded = true;
    persistIds(st);
  }

  function applySavedSettings(st) {
    var s = lsGet(bankKey(st.bankId, "settings"), null);
    if (!s) return;
    if (s.scope) st.currentScope = s.scope;
    if (s.type) st.currentType = s.type;
    if (s.subject) st.currentSubject = s.subject;
    if (s.order) st.currentOrder = s.order;
    st.showAnswers = !!s.showAnswers;
    if (s.count) st.savedCount = s.count;
    if (s.custom) st.savedCustom = s.custom;
  }

  function saveSettings() {
    if (!state) return;
    lsSet(bankKey(state.bankId, "settings"), {
      scope: selRadio("quizScope") || state.currentScope,
      type: selRadio("quizType") || state.currentType,
      subject: (els.subjectSelect && els.subjectSelect.value) || state.currentSubject,
      order: selRadio("orderMode") || state.currentOrder,
      count: selRadio("quizCount") || state.savedCount,
      custom: els.customCount.value,
      showAnswers: els.showAnswerToggle.checked
    });
  }

  /* ============================================================ 工具函数 */

  var E = function (id) { return document.getElementById(id); };

  function clean(v) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim(); }
  function nAnswer(v) { return clean(v).replace(/^答案[:：]/, "").replace(/[，、；;,\s]+/g, "").toUpperCase(); }
  function letters(v) { return nAnswer(v).replace(/[^A-F]/g, "").split("").sort().join(""); }
  function nJudge(v) {
    var val = nAnswer(v);
    if (["A", "对", "正确", "是", "TRUE", "T", "Y", "YES", "√"].indexOf(val) >= 0) return "A";
    if (["B", "错", "错误", "否", "FALSE", "F", "N", "NO", "×", "X"].indexOf(val) >= 0) return "B";
    return val;
  }
  function esc(v) {
    return clean(v).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }
  function escA(v) { return esc(v); }
  function cssEsc(v) { return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&"); }
  function shuffle(a) {
    var b = a.slice();
    for (var i = b.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = b[i]; b[i] = b[j]; b[j] = t;
    }
    return b;
  }
  function selRadio(name) {
    var e = document.querySelector('input[name="' + name + '"]:checked');
    return e ? e.value : "";
  }
  function zhCompare(a, b) {
    try { return a.localeCompare(b, "zh-Hans-CN"); } catch (e) { return a < b ? -1 : (a > b ? 1 : 0); }
  }

  /* ============================================================ 视图元素 */

  var els = {
    appTitle: E("appTitle"),
    bankSelect: E("bankSelect"), bankDesc: E("bankDesc"), bankMeta: E("bankMeta"),
    exportBankBtn: E("exportBankBtn"), deleteBankBtn: E("deleteBankBtn"),
    totalCount: E("totalCount"), correctCount: E("correctCount"),
    wrongCount: E("wrongCount"), undoneCount: E("undoneCount"), bankSize: E("bankSize"),
    scopeChoices: E("scopeChoices"), typeChoices: E("typeChoices"),
    subjectField: E("subjectField"), subjectSelect: E("subjectSelect"),
    customCountRow: E("customCountRow"), customCount: E("customCount"),
    ruleList: E("ruleList"), showAnswerToggle: E("showAnswerToggle"),
    addRuleBtn: E("addRuleBtn"), startQuizBtn: E("startQuizBtn"),
    clearWrongBtn: E("clearWrongBtn"), paperTab: E("paperTab"),
    wrongTab: E("wrongTab"), markedTab: E("markedTab"), paperSummary: E("paperSummary"),
    clearMarkBtn: E("clearMarkBtn"),
    drawerBtn: E("drawerBtn"), drawerCloseBtn: E("drawerCloseBtn"), drawerBackdrop: E("drawerBackdrop"),
    modeToggleBtn: E("modeToggleBtn"), layoutStatus: E("layoutStatus"),
    scoreBox: E("scoreBox"), content: E("content"),
    submitBtn: E("submitBtn"), submitBtnMobile: E("submitBtnMobile"),
    paperSummaryMobile: E("paperSummaryMobile"),
    importFile: E("importFile"), fileDrop: E("fileDrop"), importResult: E("importResult")
  };

  /* ============================================================ 出题范围 */

  var ORDER_MAP = {};
  function buildOrderMap() {
    ORDER_MAP = {};
    state.bank.forEach(function (q, i) { if (ORDER_MAP[q.id] == null) ORDER_MAP[q.id] = i; });
  }
  function sortByOrder(a) {
    return a.slice().sort(function (x, y) { return (ORDER_MAP[x.id] || 0) - (ORDER_MAP[y.id] || 0); });
  }

  function getScope(scope) {
    if (scope === "correct") return state.correct;
    if (scope === "wrong") return state.wrong;
    if (scope === "undone") return state.undone;
    if (scope === "marked") return state.marked;
    return state.bank;
  }
  function subjectMatch(q, subject) {
    if (!subject || subject === "all") return true;
    return q.subject === subject;
  }
  function typeMatch(q, type) {
    if (!type || type === "all") return true;
    return q.type === type;
  }
  function sLabel(s) {
    return ({
      all: "全部", correct: "正确试题", wrong: "错误试题",
      undone: "未做试题", marked: "标记试题", mixed: "混合拼题"
    })[s] || "全部";
  }
  function tLabel(t) { return (!t || t === "all") ? "全部题型" : t; }

  function isMarked(q) { return !!(state && state.markedSet[q.id]); }

  function findQuestion(qid) {
    var pool = [state.paper, state.marked, state.wrong, state.correct, state.undone];
    for (var i = 0; i < pool.length; i++) {
      for (var j = 0; j < pool[i].length; j++) {
        if (pool[i][j].id === qid) return pool[i][j];
      }
    }
    for (var k = 0; k < state.bank.length; k++) {
      if (state.bank[k].id === qid) return state.bank[k];
    }
    return null;
  }

  function toggleMark(qid) {
    var q = findQuestion(qid);
    if (!q) return;
    if (state.markedSet[qid]) {
      state.marked = state.marked.filter(function (x) { return x.id !== qid; });
    } else {
      state.marked.push(q);
    }
    state.marked.sort(function (a, b) { return (ORDER_MAP[a.id] || 0) - (ORDER_MAP[b.id] || 0); });
    rebuildMarkedSet(state);
    persistIds(state);
    if (state.mode === "marked") {
      renderList(state.marked, "marked");
    } else {
      refreshMarkUi(qid);
    }
    updateCounters();
  }

  function clearMarks() {
    if (!state.marked.length) return;
    if (!window.confirm("确认清空标记？当前题库的 " + state.marked.length + " 道标记题将全部取消标记（对错记录不受影响）。")) return;
    state.marked = [];
    rebuildMarkedSet(state);
    persistIds(state);
    if (state.mode === "marked") renderList(state.marked, "marked");
    else refreshMarkUi();
    updateCounters();
  }

  /* 就地刷新标记按钮/题卡/题号导航，避免整页重绘导致答题状态和滚动位置跳动 */
  function refreshMarkUi(qid) {
    var list = qid
      ? Array.prototype.slice.call(els.content.querySelectorAll('[data-mark-qid="' + cssEsc(qid) + '"]'))
      : Array.prototype.slice.call(els.content.querySelectorAll("[data-mark-qid]"));
    list.forEach(function (btn) {
      var id = btn.dataset.markQid;
      var on = !!state.markedSet[id];
      btn.className = "mark-btn" + (on ? " on" : "");
      btn.textContent = on ? "★ 已标记" : "☆ 标记";
      btn.title = on ? "取消标记" : "标记这道题";
      var card = btn.closest ? btn.closest(".question") : null;
      if (card) card.classList.toggle("marked", on);
    });
    if (qid) {
      var nav = E("questionNavList");
      if (nav) {
        var item = nav.querySelector('[data-nav-qid="' + cssEsc(qid) + '"]');
        if (item) item.classList.toggle("marked", !!state.markedSet[qid]);
      }
    }
  }

  function updateCounters() {
    var m = state.marked.length, w = state.wrong.length;
    if (els.markedTab) els.markedTab.textContent = "标记题（" + m + "）";
    if (els.wrongTab) els.wrongTab.textContent = "错题库（" + w + "）";
    if (els.scopeChoices) renderScopeChoices();   // 让「标记试题（N）」的计数同步
  }

  function getCount() {
    var sel = selRadio("quizCount") || "30";
    if (sel === "all") return "all";
    if (sel === "custom") return Math.max(1, parseInt(els.customCount.value || "1", 10));
    return parseInt(sel, 10);
  }

  function subjectStats(questions) {
    var counts = {}; var order = [];
    questions.forEach(function (q) {
      if (!q.subject) return;
      if (counts[q.subject] == null) { counts[q.subject] = 0; order.push(q.subject); }
      counts[q.subject]++;
    });
    order.sort(zhCompare);
    return { order: order, counts: counts };
  }

  function typeStats(questions) {
    var counts = {};
    questions.forEach(function (q) { counts[q.type] = (counts[q.type] || 0) + 1; });
    var names = Object.keys(counts).sort(function (a, b) {
      var ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
      if (ia < 0) ia = 99;
      if (ib < 0) ib = 99;
      return (ia - ib) || zhCompare(a, b);
    });
    return { names: names, counts: counts };
  }

  /* ============================================================ 渲染 */

  function renderBankSelect() {
    var groups = [], byGroup = {};
    BANK_LIST.forEach(function (b) {
      var g = b.group || "题库";
      if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
      byGroup[g].push(b);
    });
    var html = groups.map(function (g) {
      var opts = byGroup[g].map(function (b) {
        return '<option value="' + escA(b.id) + '">' + esc(b.name) + '（' + b.questions.length + ' 题）</option>';
      }).join("");
      return '<optgroup label="' + escA(g) + '">' + opts + '</optgroup>';
    }).join("");
    els.bankSelect.innerHTML = html;
  }

  function renderBankInfo() {
    var bank = BANKS[state.bankId];
    var t = typeStats(bank.questions);
    var s = subjectStats(bank.questions);
    var chips = ["共 " + bank.questions.length + " 题", t.names.length + " 种题型"];
    if (s.order.length) chips.push(s.order.length + " 个科目");
    if (!bank.builtin) chips.push("导入题库");
    els.bankMeta.innerHTML = chips.map(function (c) { return '<span class="bank-chip">' + esc(c) + "</span>"; }).join("");
    els.bankDesc.textContent = bank.desc || "";
    els.bankDesc.title = bank.source ? ("来源：" + bank.source) : "";
    els.deleteBankBtn.style.display = bank.builtin ? "none" : "";
  }

  function renderSidebar() {
    els.totalCount.textContent = state.bank.length;
    els.correctCount.textContent = state.correct.length;
    els.wrongCount.textContent = state.wrong.length;
    els.undoneCount.textContent = state.undone.length;
    els.bankSize.textContent = state.bank.length;
    renderBankInfo();
    renderScopeChoices();
    renderSubjectChoices();
    renderTypeChoices();
    renderRuleList();
    updateCounters();
  }

  function renderScopeChoices() {
    var cur = selRadio("quizScope") || state.currentScope || "all";
    var scopes = [
      ["all", "全部", state.bank.length],
      ["correct", "正确试题", state.correct.length],
      ["wrong", "错误试题", state.wrong.length],
      ["undone", "未做试题", state.undone.length],
      ["marked", "标记试题", state.marked.length]
    ];
    state.currentScope = cur;
    els.scopeChoices.innerHTML = scopes.map(function (s) {
      return '<label class="choice"><input type="radio" name="quizScope" value="' + s[0] + '"' +
        (s[0] === cur ? " checked" : "") + '><span>' + s[1] + "（" + s[2] + "）</span></label>";
    }).join("");
  }

  function renderSubjectChoices() {
    var info = subjectStats(state.bank);
    if (!info.order.length) {
      els.subjectField.style.display = "none";
      state.currentSubject = "all";
      els.subjectSelect.innerHTML = '<option value="all">全部</option>';
      return;
    }
    els.subjectField.style.display = "";
    var cur = state.currentSubject || "all";
    if (cur !== "all" && info.counts[cur] == null) cur = "all";
    var html = '<option value="all">全部科目（' + state.bank.length + ' 题）</option>';
    info.order.forEach(function (name) {
      html += '<option value="' + escA(name) + '">' + esc(name) + "（" + info.counts[name] + "）</option>";
    });
    els.subjectSelect.innerHTML = html;
    state.currentSubject = cur;
    els.subjectSelect.value = cur;
  }

  function renderTypeChoices() {
    var scope = selRadio("quizScope") || state.currentScope || "all";
    var src = getScope(scope).filter(function (q) { return subjectMatch(q, state.currentSubject); });
    var t = typeStats(src);
    var cur = selRadio("quizType") || state.currentType || "all";
    if (cur !== "all" && !t.counts[cur]) cur = "all";
    state.currentType = cur;
    var types = [["all", "全部", src.length]];
    t.names.forEach(function (n) { types.push([n, n, t.counts[n]]); });
    els.typeChoices.innerHTML = types.map(function (x) {
      return '<label class="choice"><input type="radio" name="quizType" value="' + escA(x[0]) + '"' +
        (x[0] === cur ? " checked" : "") + '><span>' + esc(x[1]) + "（" + x[2] + "）</span></label>";
    }).join("");
    els.startQuizBtn.disabled = !state.bank.length;
  }

  function renderRuleList() {
    if (!state.quizRules.length) {
      els.ruleList.innerHTML = '<div class="hint">未添加拼题规则时，将按当前设置直接出题。</div>';
      return;
    }
    els.ruleList.innerHTML = state.quizRules.map(function (r, i) {
      var parts = [sLabel(r.scope)];
      if (r.subject && r.subject !== "all") parts.push(r.subject);
      parts.push(tLabel(r.type));
      parts.push(r.count + " 题");
      return '<div class="rule-item"><span>' + esc(parts.join(" / ")) +
        '</span><button class="secondary" data-remove-rule="' + i + '">删除</button></div>';
    }).join("");
  }

  function renderQuestionNav() {
    var navSection = E("questionNavSection");
    var navList = E("questionNavList");
    var navSummary = E("questionNavSummary");
    if (!navSection || !navList) return;
    if (state.mode !== "quiz" || !state.paper.length) {
      navSection.style.display = "none";
      return;
    }
    navSection.style.display = "block";
    navList.innerHTML = state.paper.map(function (q, idx) {
      var a = state.answers[q.id] || "";
      var answered = a.length > 0;
      var cls;
      if (!answered) cls = "pending";
      else if (state.submitted) cls = isCorrect(a, q.answer, q.type) ? "correct" : "wrong";
      else cls = "answered";
      cls += isMarked(q) ? " marked" : "";
      return '<div class="q-nav-item ' + cls + '" data-nav-qid="' + escA(q.id) + '" title="' +
        esc(q.question) + '">' + (idx + 1) + "</div>";
    }).join("");
    var answered = state.paper.filter(function (q) { return (state.answers[q.id] || "").length > 0; }).length;
    navSummary.textContent = "已完成 " + answered + " / " + state.paper.length;
  }

  function groupPaper(list, order) {
    var grouped = [];
    TYPE_ORDER.forEach(function (t) {
      var g = list.filter(function (q) { return q.type === t; });
      grouped = grouped.concat(order === "random" ? shuffle(g) : sortByOrder(g));
    });
    var others = list.filter(function (q) { return TYPE_ORDER.indexOf(q.type) < 0; });
    return grouped.concat(order === "random" ? shuffle(others) : sortByOrder(others));
  }

  function buildPaper(rules, order) {
    var chosen = [], used = {};
    rules.forEach(function (r) {
      var pool = getScope(r.scope).filter(function (q) {
        return typeMatch(q, r.type) && subjectMatch(q, r.subject) && !used[q.id];
      });
      pool = order === "random" ? shuffle(pool) : sortByOrder(pool);
      var limit = r.count === "all" ? pool.length : r.count;
      pool.slice(0, limit).forEach(function (q) { used[q.id] = 1; chosen.push(q); });
    });
    return groupPaper(chosen, order);
  }

  function renderPaper() {
    els.scoreBox.classList.remove("show");
    renderQuestionNav();
    if (!state.paper.length) { renderEmpty("没有生成题目，请检查题型和数量设置。"); return; }
    els.submitBtn.disabled = state.submitted;
    els.submitBtnMobile.disabled = state.submitted;
    var head;
    if (state.quizRules.length) {
      head = "拼题 " + state.quizRules.length + " 条规则";
    } else {
      head = sLabel(state.currentScope);
      if (state.currentSubject && state.currentSubject !== "all") head += " / " + state.currentSubject;
      head += " / " + tLabel(state.currentType);
    }
    head += " / " + (state.currentOrder === "random" ? "随机出题" : "顺序练习");
    els.paperSummary.textContent = head + "：" + state.paper.length + " 题";
    els.paperSummaryMobile.textContent = els.paperSummary.textContent;
    els.content.innerHTML = state.paper.map(function (q, idx) { return renderQ(q, idx, state.showAnswers); }).join("");
  }

  function isCorrect(u, ans, t) {
    var l = nAnswer(u), r = nAnswer(ans);
    if (t === "多选题") return letters(l) === letters(r);
    if (/判断/.test(t)) return nJudge(l) === nJudge(r);
    if (/问答|填空|简答|计算|论述/.test(t)) return !!l && l === r;
    return letters(l) ? letters(l) === letters(r) : l === r;
  }

  function isCorrectKey(key, ans, type) {
    if (/判断/.test(type)) return nJudge(key) === nJudge(ans);
    var cl = letters(nAnswer(ans));
    if (!cl) return nAnswer(ans) === key;
    return cl.indexOf(key.toUpperCase()) >= 0;
  }

  function isOptChecked(q, key) {
    var a = state.answers[q.id] || "";
    return q.type === "多选题" ? a.indexOf(key) >= 0 : a === key;
  }

  function markBtnHtml(q) {
    var on = isMarked(q);
    return '<button type="button" class="mark-btn' + (on ? " on" : "") + '" data-mark-qid="' + escA(q.id) +
      '" title="' + (on ? "取消标记" : "标记这道题") + '">' + (on ? "★ 已标记" : "☆ 标记") + "</button>";
  }

  /* 题卡头部：题干 + 右侧竖排的「题型标签 / 标记按钮」 */
  function qHeadHtml(q, titleHtml) {
    var meta = esc(q.type) + (q.subject ? " · " + esc(q.subject) : "");
    return '<div class="q-head"><div class="q-title">' + titleHtml + '</div><div class="q-side">' +
      '<span class="badge">' + meta + "</span>" + markBtnHtml(q) + "</div></div>";
  }

  function renderQ(q, idx, showAns) {
    var isJudge = /判断/.test(q.type);
    var inpType = q.type === "多选题" ? "checkbox" : "radio";
    var name = "q_" + q.id;
    var opts = isJudge ? [{ key: "A", text: "是" }, { key: "B", text: "否" }] : q.options;
    var body = (opts && opts.length)
      ? '<div class="options">' + opts.map(function (o) {
        return '<label class="option' + (showAns && isCorrectKey(o.key, q.answer, q.type) ? " correct-highlight" : "") +
          '"><input type="' + inpType + '" name="' + name + '" value="' + escA(o.key) + '" data-qid="' +
          escA(q.id) + '"' + (isOptChecked(q, o.key) ? " checked" : "") + "><span><b>" + esc(o.key) + ".</b> " +
          esc(o.text) + "</span></label>";
      }).join("") + "</div>"
      : '<input class="answer-text" data-qid="' + escA(q.id) + '" type="text" placeholder="请输入答案" value="' +
        escA(state.answers[q.id] || "") + '">';
    return '<article class="question' + (isMarked(q) ? " marked" : "") + '" data-id="' + escA(q.id) + '">' +
      qHeadHtml(q, (idx + 1) + ". " + esc(q.question)) + body +
      (showAns && q.explanation ? '<div class="result show answer" style="margin-top:8px;">解析：' + esc(q.explanation) + "</div>" : "") +
      '<div class="result" id="result_' + escA(q.id) + '"></div></article>';
  }

  function ansHtml(q) {
    return "正确答案：" + esc(q.answer) + (q.explanation ? "<br>解析：" + esc(q.explanation) : "");
  }

  /* 列表里只读的选项（无勾选框）：与答题页保持同一套「正确选项标绿」规则 */
  function listOptionsHtml(q, highlight) {
    var isJudge = /判断/.test(q.type);
    var opts = isJudge ? [{ key: "A", text: "是" }, { key: "B", text: "否" }] : (q.options || []);
    if (!opts.length) return "";
    return '<div class="options">' + opts.map(function (o) {
      return '<div class="option' + (highlight && isCorrectKey(o.key, q.answer, q.type) ? " correct-highlight" : "") +
        '"><span></span><span><b>' + esc(o.key) + ".</b> " + esc(o.text) + "</span></div>";
    }).join("") + "</div>";
  }

  /* 只读列表：错题库 / 标记题共用（题干、选项、答案；答案是否显示由侧栏「显示答案」控制） */
  function renderList(questions, mode) {
    els.submitBtn.disabled = true;
    els.submitBtnMobile.disabled = true;
    els.scoreBox.classList.remove("show");
    var isMarkedList = mode === "marked";
    var showAns = !!state.showAnswers;
    var title = (isMarkedList ? "标记题" : "错题库") + "：" + questions.length + " 题" + (showAns ? "" : "（答案已隐藏）");
    els.paperSummary.textContent = title;
    els.paperSummaryMobile.textContent = title;
    if (!questions.length) {
      renderEmpty(
        isMarkedList
          ? "还没有标记的题目。答题时点题目右上角的「☆ 标记」，就会收进这里。"
          : "错题库为空。答题提交后，答错的题目会自动加入这里。",
        title
      );
      return;
    }
    els.content.innerHTML = questions.map(function (q, idx) {
      var markButton = isMarkedList
        ? '<button type="button" class="unmark-btn" data-mark-qid="' + escA(q.id) + '">取消标记</button>'
        : "";
      var answerPart = showAns
        ? '<div class="result show answer">正确答案：' + esc(q.answer) +
          (q.explanation ? "<br>解析：" + esc(q.explanation) : "") + "</div>"
        : '<div class="list-hint">正确答案与解析已隐藏　' +
          '<button type="button" class="link-btn" data-action="toggle-answers">点这里显示</button>' +
          "（也可用侧栏的「显示答案」开关）</div>";
      return '<article class="question' + (isMarked(q) ? " marked" : "") + '" data-id="' + escA(q.id) + '">' +
        qHeadHtml(q, (idx + 1) + ". " + esc(q.question)) +
        listOptionsHtml(q, showAns) + answerPart + markButton + "</article>";
    }).join("");
  }

  function renderWrongList() { renderList(state.wrong, "wrong"); }

  function renderMarkedList() { renderList(state.marked, "marked"); }

  function renderEmpty(text, summary) {
    els.submitBtn.disabled = true;
    els.submitBtnMobile.disabled = true;
    var nsec = E("questionNavSection");
    if (nsec) nsec.style.display = "none";
    els.paperSummary.textContent = summary || (state.bank.length ? "请选择出题设置后开始。" : "题库为空。");
    els.paperSummaryMobile.textContent = els.paperSummary.textContent;
    els.content.innerHTML = '<div class="empty">' + esc(text || "选择出题设置后，点击开始出题按钮。") + "</div>";
  }

  /* ============================================================ 交互 */

  function capAnswer(e) {
    var t = e.target, qid = t.dataset ? t.dataset.qid : null;
    if (!qid || state.submitted) return;
    var q = state.paper.find(function (x) { return x.id === qid; });
    if (!q) return;
    if (q.type === "多选题") {
      var chk = document.querySelectorAll('input[data-qid="' + cssEsc(qid) + '"]:checked');
      var vs = [];
      chk.forEach(function (x) { vs.push(x.value); });
      state.answers[qid] = vs.sort().join("");
    } else {
      state.answers[qid] = t.value;
    }
    renderQuestionNav();
  }

  function rText(a, c, u) {
    if (!a) return "未作答";
    if (c) return "回答正确";
    return "回答错误，你的答案：" + esc(u);
  }

  function submitPaper() {
    if (!state.paper.length) return;
    state.submitted = true;
    var right = 0, wrong = 0, undone = 0;
    var pC = new Map(state.correct.map(function (q) { return [q.id, q]; }));
    var pW = new Map(state.wrong.map(function (q) { return [q.id, q]; }));
    var pU = new Map(state.undone.map(function (q) { return [q.id, q]; }));
    state.paper.forEach(function (q) {
      var u = nAnswer(state.answers[q.id] || ""), answered = u.length > 0;
      var correct = answered && isCorrect(u, q.answer, q.type);
      var box = document.getElementById("result_" + q.id);
      if (!answered) { undone++; if (!pC.has(q.id) && !pW.has(q.id)) pU.set(q.id, q); }
      else if (correct) { right++; pC.set(q.id, q); pW.delete(q.id); pU.delete(q.id); }
      else { wrong++; pC.delete(q.id); pW.set(q.id, q); pU.delete(q.id); }
      if (box) {
        box.className = "result show " + (correct ? "ok" : "bad");
        box.innerHTML = rText(answered, correct, u) + "<br>" + ansHtml(q);
      }
    });
    state.correct = Array.from(pC.values());
    state.wrong = Array.from(pW.values());
    state.undone = Array.from(pU.values());
    persistIds(state);
    renderSidebar();
    var rate = state.paper.length ? Math.round(right / state.paper.length * 100) : 0;
    els.scoreBox.innerHTML = "得分：<b>" + right + "</b> / " + state.paper.length + "，正确率 <b>" + rate +
      "%</b>。答错 <b>" + wrong + "</b> 题进入错题库，未做 <b>" + undone + "</b> 题保留未做状态。";
    els.scoreBox.classList.add("show");
    els.submitBtn.disabled = true;
    els.submitBtnMobile.disabled = true;
    els.paperSummary.textContent = "已提交：正确 " + right + "，错误 " + wrong + "，未做 " + undone;
    els.paperSummaryMobile.textContent = els.paperSummary.textContent;
    renderQuestionNav();
    updateCounters();
    closeDrawer();
  }

  function startQuiz() {
    if (!state.bank.length) return;
    var order = selRadio("orderMode") || "sequential";
    var uiScope = selRadio("quizScope") || "all";
    var uiType = selRadio("quizType") || "all";
    var uiSubject = els.subjectSelect.value || "all";
    var rules = state.quizRules.length ? state.quizRules : [{
      scope: uiScope, type: uiType, subject: uiSubject, count: getCount()
    }];
    state.currentScope = uiScope;
    state.currentType = uiType;
    state.currentSubject = uiSubject;
    state.currentOrder = order;
    state.showAnswers = els.showAnswerToggle.checked;
    state.paper = buildPaper(rules, order);
    if (!state.paper.length) {
      renderEmpty("没有生成题目，请检查练习模式、试题类型和数量设置（或删除部分拼题规则）。");
      return;
    }
    state.answers = {};
    state.submitted = false;
    state.mode = "quiz";
    setTab("paper");
    renderPaper();
    els.paperSummaryMobile.textContent = els.paperSummary.textContent;
    saveSettings();
    closeDrawer();
  }

  function addQuizRule() {
    state.quizRules.push({
      scope: selRadio("quizScope") || "all",
      type: selRadio("quizType") || "all",
      subject: els.subjectSelect.value || "all",
      count: getCount()
    });
    renderRuleList();
  }

  function clearWrong() {
    if (!state.wrong.length) return;
    if (!window.confirm("确认清空错题库？当前题库的所有错题将移回未做试题。")) return;
    var u = new Map(state.undone.map(function (q) { return [q.id, q]; }));
    state.wrong.forEach(function (q) { u.set(q.id, q); });
    state.wrong = [];
    state.undone = Array.from(u.values());
    persistIds(state);
    renderSidebar();
    updateCounters();
    if (state.mode === "wrong") renderWrongList();
  }

  function resetAll() {
    if (!window.confirm("确认全部重置？当前题库的正确、错误记录将清空，全部变回未做试题（标记不受影响）。")) return;
    var all = [], seen = {};
    state.correct.concat(state.wrong, state.undone).forEach(function (q) {
      if (!seen[q.id]) { seen[q.id] = 1; all.push(q); }
    });
    all.sort(function (x, y) { return (ORDER_MAP[x.id] || 0) - (ORDER_MAP[y.id] || 0); });
    state.correct = []; state.wrong = []; state.undone = all;
    persistIds(state);
    renderSidebar();
  }

  function toggleAns() {
    state.showAnswers = els.showAnswerToggle.checked;
    saveSettings();
    if (state.mode === "quiz" && state.paper.length) renderPaper();
    else if (state.mode === "wrong") renderWrongList();
    else if (state.mode === "marked") renderMarkedList();
  }

  function switchTab(t) {
    closeDrawer();
    if (t === "wrong") {
      state.mode = "wrong";
      setTab("wrong");
      renderWrongList();
    } else if (t === "marked") {
      state.mode = "marked";
      setTab("marked");
      renderMarkedList();
    } else {
      state.mode = "quiz";
      setTab("paper");
      if (state.paper.length) renderPaper();
      else renderEmpty();
    }
  }

  function setTab(t) {
    els.paperTab.classList.toggle("active", t === "paper");
    els.wrongTab.classList.toggle("active", t === "wrong");
    if (els.markedTab) els.markedTab.classList.toggle("active", t === "marked");
  }

  /* ============================================================ 侧栏形态（抽屉 / 并排） */

  function layoutApi() {
    return window.YXA_LAYOUT || null;
  }

  function drawerModeActive() {
    var root = document.documentElement;
    return !!(root && root.classList && root.classList.contains("drawer-mode"));
  }

  function updateLayoutStatus() {
    if (!els.layoutStatus) return;
    var w = window.innerWidth || 0, h = window.innerHeight || 0;
    var coarse = false;
    try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch (e) {}
    var pref = layoutApi() ? layoutApi().pref() : "auto";
    var prefLabel = pref === "auto" ? "自动" : (pref === "drawer" ? "手动·抽屉" : "手动·并排");
    els.layoutStatus.textContent = "v" + APP_VERSION + " · 视口 " + w + "×" + h +
      " · 指针" + (coarse ? "粗(触屏)" : "细(鼠标)") + " · " + prefLabel +
      " · " + (drawerModeActive() ? "抽屉" : "并排");
  }

  function applyLayoutMode() {
    var drawer = layoutApi() ? layoutApi().apply() : drawerModeActive();
    if (!drawer) closeDrawer();
    if (els.modeToggleBtn) {
      els.modeToggleBtn.textContent = drawer ? "切换为并排显示" : "切换为抽屉显示（题目满屏）";
    }
    updateLayoutStatus();
    return drawer;
  }

  function toggleLayoutMode() {
    var api = layoutApi();
    var wantDrawer = !drawerModeActive();
    if (api) api.setPref(wantDrawer ? "drawer" : "side");
    applyLayoutMode();
    if (wantDrawer) openDrawer();
    else window.scrollTo(0, 0);
  }

  /* ============================================================ 侧栏抽屉（平板/手机） */

  function openDrawer() {
    document.body.classList.add("drawer-open");
  }

  function closeDrawer() {
    document.body.classList.remove("drawer-open");
  }

  function isDrawerOpen() {
    return document.body.classList.contains("drawer-open");
  }

  function toggleDrawer() {
    if (isDrawerOpen()) closeDrawer();
    else openDrawer();
  }

  /* ============================================================ 题库切换 */

  function syncCountControls() {
    var wanted = state.savedCount || "30";
    var found = false;
    document.querySelectorAll('input[name="quizCount"]').forEach(function (r) {
      var on = (r.value === wanted);
      r.checked = on;
      if (on) found = true;
    });
    if (!found) {
      document.querySelectorAll('input[name="quizCount"]').forEach(function (r) {
        if (r.value === "30") r.checked = true;
      });
      wanted = "30";
      state.savedCount = "30";
    }
    els.customCount.value = state.savedCustom || 30;
    els.customCountRow.classList.toggle("show", wanted === "custom");
    var orderName = state.currentOrder === "random" ? "random" : "sequential";
    document.querySelectorAll('input[name="orderMode"]').forEach(function (r) {
      r.checked = (r.value === orderName);
    });
    els.showAnswerToggle.checked = !!state.showAnswers;
  }

  function activate(id, opts) {
    if (!BANKS[id]) return;
    if (state) persistIds(state);
    if (!runtime[id]) runtime[id] = createState(BANKS[id]);
    state = runtime[id];
    if (!state.loaded) {
      reconcile(state);
      applySavedSettings(state);
    }
    lsSet(KEY_LAST, id);
    els.bankSelect.value = id;
    var appName = META.appName || "乙烯答题练习";
    document.title = BANKS[id].name + " · " + appName;
    els.appTitle.textContent = BANKS[id].name;
    buildOrderMap();
    state.mode = "quiz";
    setTab("paper");
    els.scoreBox.classList.remove("show");
    els.submitBtn.disabled = state.paper.length ? state.submitted : true;
    els.submitBtnMobile.disabled = els.submitBtn.disabled;
    syncCountControls();
    renderSidebar();
    if (state.paper.length) renderPaper();
    else renderEmpty("已切换到「" + BANKS[id].name + "」，选择出题设置后点击开始出题。");
    renderQuestionNav();
    saveSettings();
    closeDrawer();
    if (opts && opts.scrollTop) window.scrollTo(0, 0);
  }

  /* ============================================================ 导入导出 */

  function slug(s) {
    var v = String(s == null ? "" : s).replace(/\.[^.]+$/, "")
      .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return v || "bank";
  }

  function normType(t) {
    var v = clean(t).replace(/\s+/g, "");
    if (/判断/.test(v)) return "判断题";
    if (/多选/.test(v)) return "多选题";
    if (/单选|单项|选择/.test(v)) return "单选题";
    if (/填空/.test(v)) return "填空题";
    if (/简答|问答/.test(v)) return "简答题";
    if (/计算/.test(v)) return "计算题";
    return v;
  }

  function normJudgeAnswer(raw) {
    var v = nAnswer(raw);
    if (["A", "对", "正确", "是", "TRUE", "T", "Y", "YES", "√"].indexOf(v) >= 0) return "A";
    if (["B", "错", "错误", "否", "FALSE", "F", "N", "NO", "×", "X"].indexOf(v) >= 0) return "B";
    return v;
  }

  /* 表头兼容：去掉 BOM 与首尾空白，便于按中文列名取值 */
  function normalizeRow(row) {
    var out = {};
    Object.keys(row).forEach(function (k) {
      out[String(k).replace(/^\uFEFF/, "").trim()] = row[k];
    });
    return out;
  }

  function parseRows(rawRows) {
    var rows = rawRows.map(normalizeRow);
    var bank = [];
    var skipped = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var qtype = normType(r["题型"] || r["类型"] || "");
      var question = clean(r["题干"] || r["题目内容"] || r["题目"] || r["试题"] || "");
      var rawAnswer = clean(r["答案"] || r["正确答案"] || "");
      var explanation = clean(r["解析"] || r["说明"] || r["关联题目"] || r["评分标准"] || "");
      var subject = clean(r["科目"] || r["文件名称"] || r["关键字"] || r["作业类型"] || "");
      var opts = [];
      var keys = ["A", "B", "C", "D", "E", "F"];
      for (var k = 0; k < keys.length; k++) {
        var col = "选项" + keys[k];
        if (r[col] && clean(r[col])) opts.push({ key: keys[k], text: clean(r[col]) });
      }
      if (!opts.length && r["可选项"]) {
        var parts = String(r["可选项"]).split(/[;；\n]/);
        for (var j = 0; j < parts.length; j++) {
          if (clean(parts[j])) opts.push({ key: keys[j] || String.fromCharCode(65 + j), text: clean(parts[j]) });
        }
      }
      if (!question && !opts.length) { skipped++; continue; }
      var ansUp = nAnswer(rawAnswer);
      var looksJudge = ["A", "B", "对", "错", "正确", "错误", "是", "否", "√", "×",
        "T", "F", "TRUE", "FALSE", "Y", "N"].indexOf(ansUp) >= 0;
      if (/判断/.test(qtype) || (!opts.length && looksJudge)) {
        qtype = "判断题";
        opts = [{ key: "A", text: "对" }, { key: "B", text: "错" }];
        rawAnswer = normJudgeAnswer(rawAnswer);
      } else if (!opts.length) {
        if (!qtype) qtype = "简答题";
        rawAnswer = clean(rawAnswer);
      } else {
        if (!qtype) qtype = "单选题";
        var lettersOnly = ansUp.replace(/[^A-F]/g, "").split("").sort();
        rawAnswer = lettersOnly.length ? lettersOnly.join("") : ansUp;
      }
      var item = {
        id: String(i + 1).padStart(4, "0"),
        type: qtype,
        question: question,
        options: opts,
        answer: rawAnswer,
        explanation: explanation
      };
      if (subject) item.subject = subject;
      bank.push(item);
    }
    return { questions: bank, skipped: skipped };
  }

  function handleImport(file) {
    els.importResult.style.color = "";
    els.importResult.textContent = "正在解析 " + file.name + " …";
    var isCsv = /\.csv$/i.test(file.name);
    var reader = new FileReader();
    reader.onerror = function () {
      els.importResult.textContent = "读取文件失败：" + file.name;
      els.importResult.style.color = "var(--bad)";
    };
    reader.onload = function (e) {
      try {
        if (typeof XLSX === "undefined") throw new Error("题库解析库未加载（vendor/xlsx.full.min.js 缺失）");
        var wb = isCsv
          ? XLSX.read(e.target.result, { type: "string" })
          : XLSX.read(e.target.result, { type: "array" });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
        if (!rows.length) throw new Error("文件里没有数据行");
        var parsed = parseRows(rows);
        if (!parsed.questions.length) throw new Error("没有解析出任何题目，请检查表头（题型/题干/答案/选项A-D/可选项/科目）");
        var displayName = file.name.replace(/\.[^.]+$/, "");
        var id = "imp:" + slug(file.name);
        if (BANKS[id] && !window.confirm("题库「" + displayName + "」已存在，是否用新文件覆盖？")) {
          els.importResult.textContent = "已取消导入。";
          return;
        }
        var bank = {
          id: id, name: "导入：" + displayName, group: GROUP_IMPORTED,
          desc: "由文件 " + file.name + " 导入" + (parsed.skipped ? "（跳过空行 " + parsed.skipped + " 行）" : ""),
          source: file.name, builtAt: new Date().toLocaleString(), questions: parsed.questions,
          builtin: false
        };
        BANKS[id] = bank;
        if (!lsSet(bankKey(id, "questions"), bank.questions)) {
          throw new Error("题库太大，无法写入本地存储，请拆分后再导入");
        }
        saveImportedRegistry();
        buildBankList();
        renderBankSelect();
        delete runtime[id];
        els.importResult.style.color = "var(--ok)";
        els.importResult.textContent = "导入成功：共 " + bank.questions.length + " 题，已切换到该题库。";
        activate(id);
      } catch (err) {
        els.importResult.textContent = "解析失败：" + (err && err.message ? err.message : err);
        els.importResult.style.color = "var(--bad)";
      }
    };
    if (isCsv) reader.readAsText(file, "utf-8");
    else reader.readAsArrayBuffer(file);
  }

  function exportBank() {
    var bank = BANKS[state.bankId];
    if (!bank) return;
    var payload = {
      id: bank.id, name: bank.name, group: bank.group, desc: bank.desc,
      source: bank.source, exportedAt: new Date().toISOString(),
      questions: bank.questions
    };
    var blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = bank.name.replace(/[\\/:*?"<>|]/g, "_") + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function deleteImportedBank() {
    var bank = BANKS[state.bankId];
    if (!bank || bank.builtin) return;
    if (!window.confirm("确认删除导入的题库「" + bank.name + "」？其练习记录也会一并删除。")) return;
    var id = bank.id;
    delete BANKS[id];
    delete runtime[id];
    lsDel(bankKey(id, "questions"));
    lsDel(bankKey(id, "ids"));
    lsDel(bankKey(id, "settings"));
    saveImportedRegistry();
    buildBankList();
    renderBankSelect();
    activate(BANK_LIST[0].id);
  }

  /* ============================================================ 事件绑定 */

  function wireEvents() {
    els.bankSelect.addEventListener("change", function () {
      activate(els.bankSelect.value, { scrollTop: true });
    });

    els.exportBankBtn.addEventListener("click", exportBank);
    els.deleteBankBtn.addEventListener("click", deleteImportedBank);

    els.addRuleBtn.addEventListener("click", addQuizRule);
    els.startQuizBtn.addEventListener("click", startQuiz);
    els.showAnswerToggle.addEventListener("change", toggleAns);
    els.scopeChoices.addEventListener("change", function () {
      renderTypeChoices();
      saveSettings();
    });
    els.typeChoices.addEventListener("change", saveSettings);
    els.subjectSelect.addEventListener("change", function () {
      state.currentSubject = els.subjectSelect.value || "all";
      renderTypeChoices();
      saveSettings();
    });
    els.ruleList.addEventListener("click", function (e) {
      var i = e.target.dataset ? e.target.dataset.removeRule : null;
      if (i == null) return;
      state.quizRules.splice(Number(i), 1);
      renderRuleList();
    });
    els.clearWrongBtn.addEventListener("click", clearWrong);
    els.clearMarkBtn.addEventListener("click", clearMarks);
    E("resetAllBtn").addEventListener("click", resetAll);

    var importFile = els.importFile;
    var fileDrop = els.fileDrop;
    fileDrop.addEventListener("click", function () { importFile.click(); });
    importFile.addEventListener("change", function () {
      if (importFile.files.length) handleImport(importFile.files[0]);
      importFile.value = "";
    });
    fileDrop.addEventListener("dragover", function (e) {
      e.preventDefault();
      fileDrop.classList.add("dragover");
    });
    fileDrop.addEventListener("dragleave", function () { fileDrop.classList.remove("dragover"); });
    fileDrop.addEventListener("drop", function (e) {
      e.preventDefault();
      fileDrop.classList.remove("dragover");
      if (e.dataTransfer.files.length) handleImport(e.dataTransfer.files[0]);
    });

    els.submitBtn.addEventListener("click", submitPaper);
    els.submitBtnMobile.addEventListener("click", submitPaper);
    els.paperTab.addEventListener("click", function () { switchTab("paper"); });
    els.wrongTab.addEventListener("click", function () { switchTab("wrong"); });
    if (els.markedTab) els.markedTab.addEventListener("click", function () { switchTab("marked"); });
    els.content.addEventListener("change", capAnswer);
    els.content.addEventListener("input", capAnswer);

    /* 题卡上的「☆ 标记 / ★ 已标记 / 取消标记」按钮、列表里的「点这里显示」答案按钮（事件委托） */
    els.content.addEventListener("click", function (e) {
      var target = e.target;
      if (!target || !target.closest) return;

      var ansBtn = target.closest('[data-action="toggle-answers"]');
      if (ansBtn) {
        e.preventDefault();
        els.showAnswerToggle.checked = true;
        toggleAns();
        return;
      }

      var btn = target.closest("[data-mark-qid]");
      if (!btn) return;
      e.preventDefault();
      toggleMark(btn.dataset.markQid);
    });

    /* 侧栏抽屉：小按钮呼出，点遮罩/关闭键/跳题后自动收起 */
    if (els.drawerBtn) els.drawerBtn.addEventListener("click", toggleDrawer);
    if (els.drawerCloseBtn) els.drawerCloseBtn.addEventListener("click", closeDrawer);
    if (els.drawerBackdrop) els.drawerBackdrop.addEventListener("click", closeDrawer);
    if (els.modeToggleBtn) els.modeToggleBtn.addEventListener("click", toggleLayoutMode);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isDrawerOpen()) closeDrawer();
    });

    /* 转动屏幕/改窗口大小时重算（自动模式）；状态行随时更新，便于排查 */
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        applyLayoutMode();
      }, 150);
    });
    window.addEventListener("orientationchange", function () {
      setTimeout(applyLayoutMode, 350);
    });

    E("questionNavList").addEventListener("click", function (e) {
      var item = e.target.closest(".q-nav-item");
      if (!item) return;
      var qid = item.dataset.navQid;
      var qEl = document.querySelector('.question[data-id="' + cssEsc(qid) + '"]');
      closeDrawer();
      if (!qEl) return;
      qEl.scrollIntoView({ behavior: "smooth", block: "center" });
      qEl.style.boxShadow = "0 0 0 3px var(--accent)";
      setTimeout(function () { qEl.style.boxShadow = ""; }, 1500);
    });

    document.querySelectorAll('input[name="quizCount"]').forEach(function (r) {
      r.addEventListener("change", function () {
        els.customCountRow.classList.toggle("show", r.value === "custom");
        state.savedCount = selRadio("quizCount") || state.savedCount;
        saveSettings();
      });
    });
    els.customCount.addEventListener("change", function () {
      state.savedCustom = els.customCount.value;
      saveSettings();
    });
    document.querySelectorAll('input[name="orderMode"]').forEach(function (r) {
      r.addEventListener("change", function () {
        state.currentOrder = selRadio("orderMode") || "sequential";
        saveSettings();
      });
    });
  }

  /* ============================================================ 启动 */

  function boot() {
    registerBuiltins();
    loadImported();
    if (!Object.keys(BANKS).length) {
      els.content.innerHTML = '<div class="empty">没有加载到任何题库，请检查 banks/ 目录下的题库文件。</div>';
      return;
    }
    buildBankList();
    renderBankSelect();
    wireEvents();
    applyLayoutMode();
    var last = lsGet(KEY_LAST, null);
    if (!last || !BANKS[last]) last = BANK_LIST[0].id;
    activate(last);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
