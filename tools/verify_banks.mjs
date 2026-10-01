/* 静态校验：题库文件、App 脚本与清单是否完整自洽。
   用法（在 乙烯答题App 目录下）：node tools/verify_banks.mjs
   任何断言失败都会以非零退出码结束并打印明细。 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.dirname(HERE);

const failures = [];
const notes = [];
function fail(msg) { failures.push(msg); }
function note(msg) { notes.push(msg); }

function readText(p) { return fs.readFileSync(p, "utf8"); }

/* ---------------------------------------------------------------- 题库 */

const TAGS = /<[A-Za-z/][^<>]*>/;
const CHOICE = /^(单选题|多选题)$/;
const JUDGE = /判断/;
const SUBJECTIVE = /(填空|简答|问答|计算|论述|名词解释)/;

const bankDir = path.join(APP, "banks");
const bankFiles = fs.readdirSync(bankDir).filter((f) => f.endsWith(".js")).sort();

const sandbox = { window: {} };
const ctx = vm.createContext(sandbox);

// index.js 先加载
const indexFile = "index.js";
if (!bankFiles.includes(indexFile)) fail("缺少 banks/index.js");
else vm.runInContext(readText(path.join(bankDir, indexFile)), ctx, { filename: indexFile });

const dataFiles = bankFiles.filter((f) => f !== indexFile);
if (!dataFiles.length) fail("banks/ 下没有题库数据文件");
for (const f of dataFiles) {
  try {
    vm.runInContext(readText(path.join(bankDir, f)), ctx, { filename: f });
  } catch (e) {
    fail(`${f} 无法加载：${e.message}`);
  }
}

const YXA = sandbox.window.YXA || {};
const banks = YXA.banks || [];
const order = YXA.ORDER || [];

if (banks.length !== 5) fail(`题库数量应为 5，实际 ${banks.length}`);
const loadedIds = banks.map((b) => b.id).sort();
const orderIds = [...order].sort();
if (JSON.stringify(orderIds) !== JSON.stringify(loadedIds)) {
  fail(`banks/index.js 的 ORDER 与题库文件不一致：${JSON.stringify(order)} vs ${JSON.stringify(banks.map((b) => b.id))}`);
}
if (order[0] !== "wf") fail(`ORDER 首个题库应为 wf，实际 ${order[0]}`);

const ids = new Set();
let grandTotal = 0;
for (const bank of banks) {
  const tag = `${bank.id}`;
  if (!bank.id || !bank.name) fail(`${tag}: 缺少 id 或 name`);
  if (ids.has(bank.id)) fail(`${tag}: 题库 id 重复`);
  ids.add(bank.id);
  const qs = bank.questions;
  if (!Array.isArray(qs) || !qs.length) { fail(`${tag}: 没有题目`); continue; }
  grandTotal += qs.length;

  const qids = new Set();
  const dupIds = [];
  const tagHits = [];
  const badAnswer = [];
  const emptyQ = [];
  const subjMissing = [];
  const types = {};
  let subjects = 0;

  for (const q of qs) {
    if (!q || typeof q !== "object") { fail(`${tag}: 存在非对象题目`); continue; }
    types[q.type] = (types[q.type] || 0) + 1;
    if (!q.question) emptyQ.push(q.id);
    if (qids.has(q.id)) dupIds.push(q.id);
    qids.add(q.id);
    const blob = [q.question, q.explanation, q.answer, (q.options || []).map((o) => o.text).join(" ")].join(" ");
    if (TAGS.test(blob)) tagHits.push(q.id);
    const opts = q.options || [];
    if (CHOICE.test(q.type)) {
      if (opts.length < 2) badAnswer.push(`${q.id}(选项不足)`);
      else {
        const keys = new Set(opts.map((o) => String(o.key).toUpperCase()));
        for (const ch of String(q.answer)) {
          if (!keys.has(ch)) { badAnswer.push(`${q.id}(答案${q.answer}不在选项${[...keys].join("")})`); break; }
        }
      }
    } else if (JUDGE.test(q.type)) {
      if (q.answer !== "A" && q.answer !== "B") badAnswer.push(`${q.id}(判断题答案${q.answer})`);
    } else if (SUBJECTIVE.test(q.type)) {
      if (!q.answer) badAnswer.push(`${q.id}(主观题无答案)`);
    } else {
      note(`${tag}: 未分类题型「${q.type}」×${qs.filter((x) => x.type === q.type).length}`);
    }
    if (bank.id === "cx") {
      if (!q.subject) subjMissing.push(q.id);
      else subjects++;
    }
  }

  if (dupIds.length) fail(`${tag}: 重复题号 ${dupIds.length} 个，例如 ${dupIds.slice(0, 5).join(",")}`);
  if (emptyQ.length) fail(`${tag}: 空题干 ${emptyQ.length} 个，例如 ${emptyQ.slice(0, 5).join(",")}`);
  if (tagHits.length) fail(`${tag}: 仍残留 HTML/XML 标签 ${tagHits.length} 个，例如 ${tagHits.slice(0, 5).join(",")}`);
  if (bank.id !== "cx" && badAnswer.length) fail(`${tag}: 答案与选项不匹配 ${badAnswer.length} 个，例如 ${badAnswer.slice(0, 5).join(" ")}`);
  if (bank.id === "cx" && badAnswer.length) note(`cx: 源数据缺陷 ${badAnswer.length} 个（原题库即如此）：${badAnswer.slice(0, 3).join(" ")}`);
  if (bank.id === "cx" && subjMissing.length) fail(`cx: ${subjMissing.length} 题缺少科目，例如 ${subjMissing.slice(0, 5).join(",")}`);

  console.log(`  ${bank.id.padEnd(7)} ${String(qs.length).padStart(5)} 题  ${Object.entries(types).map(([t, n]) => `${t} ${n}`).join("、")}` +
    (bank.id === "cx" ? `  科目 ${new Set(qs.map((q) => q.subject)).size} 个` : ""));
}

/* ---------------------------------------------------------------- 清单 / 脚本 / 页面 */

const manifestPath = path.join(APP, "manifest.json");
let manifest = null;
try {
  manifest = JSON.parse(readText(manifestPath));
} catch (e) {
  fail(`manifest.json 无法解析：${e.message}`);
}
if (manifest) {
  if (manifest.manifest_version !== 3) fail("manifest_version 应为 3");
  for (const [size, rel] of Object.entries(manifest.icons || {})) {
    if (!fs.existsSync(path.join(APP, rel))) fail(`manifest 图标缺失：${rel} (${size})`);
  }
  const sw = manifest.background && manifest.background.service_worker;
  if (!sw || !fs.existsSync(path.join(APP, sw))) fail(`manifest 的 service_worker 缺失：${sw}`);
}

for (const script of ["app.js", "background.js", "pwa.js", "layout.js", "sw.js", ...bankFiles.map((f) => "banks/" + f)]) {
  const p = path.join(APP, script);
  if (!fs.existsSync(p)) { fail(`缺少脚本 ${script}`); continue; }
  try {
    new vm.Script(readText(p), { filename: script });
  } catch (e) {
    fail(`${script} 语法错误：${e.message}`);
  }
}

const htmlPath = path.join(APP, "index.html");
const html = readText(htmlPath);
for (const bank of banks) {
  if (!html.includes(`banks/${bank.id}.js`)) fail(`index.html 未引入 banks/${bank.id}.js`);
}
if (/<script\b[^>]*>(?![ \t]*<\/script>)/i.test(html.replace(/<script src=[^>]*><\/script>/gi, ""))) {
  fail("index.html 含有内联脚本（扩展页 CSP 会拒绝）");
}
if (/(src|href)\s*=\s*["']https?:/i.test(html)) fail("index.html 引用了远程资源，离线场景不可用");
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const rel = m[1];
  if (/^https?:/i.test(rel)) continue;
  if (!fs.existsSync(path.join(APP, rel.replace(/\?.*$/, "")))) fail(`index.html 引用的文件不存在：${rel}`);
}

/* ---------------------------------------------------------------- PWA / GitHub Pages */

const webManifestPath = path.join(APP, "manifest.webmanifest");
let webManifest = null;
try {
  webManifest = JSON.parse(readText(webManifestPath));
} catch (e) {
  fail(`manifest.webmanifest 无法解析：${e.message}`);
}
if (webManifest) {
  for (const field of ["name", "short_name", "start_url", "scope", "display", "theme_color"]) {
    if (!webManifest[field]) fail(`manifest.webmanifest 缺少 ${field}`);
  }
  if (webManifest.display !== "standalone" && webManifest.display !== "fullscreen" && webManifest.display !== "minimal-ui") {
    fail(`manifest.webmanifest 的 display 不利于安装：${webManifest.display}`);
  }
  const icons = webManifest.icons || [];
  for (const need of ["192x192", "512x512"]) {
    if (!icons.some((i) => i.sizes === need)) fail(`manifest.webmanifest 缺少 ${need} 图标`);
  }
  if (!icons.some((i) => i.purpose === "maskable")) fail("manifest.webmanifest 缺少 maskable 图标");
  for (const icon of icons) {
    if (!fs.existsSync(path.join(APP, icon.src))) fail(`PWA 图标不存在：${icon.src}`);
  }
  if (!html.includes('rel="manifest"')) fail("index.html 没有引用 manifest.webmanifest");
}
if (!html.includes("pwa.js")) fail("index.html 没有引入 pwa.js（离线缓存不会生效）");

// app.js 里 E("xxx") 引用的元素必须真的存在于 index.html，避免改 HTML 后留下空引用
const appSource = readText(path.join(APP, "app.js"));
const referencedIds = new Set();
for (const m of appSource.matchAll(/\bE\("([A-Za-z0-9_-]+)"\)/g)) referencedIds.add(m[1]);
for (const m of appSource.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)) referencedIds.add(m[1]);
const missingIds = [...referencedIds].filter((id) => !html.includes(`id="${id}"`));
if (missingIds.length) fail(`app.js 引用了 index.html 里不存在的元素：${missingIds.join(", ")}`);
else console.log(`  app.js 引用的 ${referencedIds.size} 个元素 id 在 index.html 中都存在`);

for (const el of ["drawerBtn", "drawerBackdrop", "drawerCloseBtn", "markedTab", "clearMarkBtn"]) {
  if (!html.includes(`id="${el}"`)) fail(`index.html 缺少平板抽屉/标记所需元素：${el}`);
}
if (!/\.mark-btn|\.q-side/.test(readText(path.join(APP, "app.css")))) fail("app.css 缺少标记按钮样式");
if (!/drawer-open/.test(readText(path.join(APP, "app.css")))) fail("app.css 缺少侧栏抽屉样式");

const swSource = readText(path.join(APP, "sw.js"));
const swListMatch = /const PRECACHE = \[([\s\S]*?)\]/.exec(swSource);
let precache = [];
if (!swListMatch) {
  fail("sw.js 里找不到 PRECACHE 列表");
} else {
  precache = [...swListMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!precache.length) fail("sw.js 的 PRECACHE 为空");
  for (const rel of precache) {
    if (!fs.existsSync(path.join(APP, rel.replace(/^\.\//, "").replace(/\?.*$/, "")))) {
      fail(`sw.js 预缓存的文件不存在：${rel}`);
    }
  }
  for (const rel of ["index.html", "app.css", "app.js", "pwa.js", "layout.js", "manifest.webmanifest"]) {
    if (!precache.some((p) => p.replace(/^\.\//, "").replace(/\?.*$/, "") === rel)) {
      fail(`sw.js 预缓存缺少 ${rel}`);
    }
  }
  for (const bank of banks) {
    if (!precache.includes(`./banks/${bank.id}.js`)) fail(`sw.js 预缓存缺少 banks/${bank.id}.js`);
  }
  if (!precache.includes("./vendor/xlsx.full.min.js")) fail("sw.js 预缓存缺少 vendor/xlsx.full.min.js");
  console.log(`  sw.js 预缓存 ${precache.length} 个文件，全部存在`);
}

// index.html 里引用的本地文件必须与 sw.js 的预缓存清单一致（否则离线会 503 / 更新会不生效）
const htmlRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((rel) => !/^https?:/i.test(rel));
const missingInPrecache = htmlRefs.filter((rel) => {
  const norm = rel.replace(/^\.\//, "");
  return !precache.some((p) => p.replace(/^\.\//, "") === norm);
});
if (missingInPrecache.length) {
  fail(`index.html 引用了未加入 sw.js 预缓存的文件（离线会失败）：${missingInPrecache.join(", ")}`);
} else {
  console.log(`  index.html 的 ${htmlRefs.length} 个本地引用都在 sw.js 预缓存里`);
}

// 版本号必须三处一致：index.html 的 ?v=、sw.js 的 ?v=、app.js 的 APP_VERSION
const appVer = /var APP_VERSION = "([^"]+)"/.exec(appSource);
const htmlVers = new Set([...html.matchAll(/\?v=([0-9.]+)/g)].map((m) => m[1]));
const swVers = new Set([...swSource.matchAll(/\?v=([0-9.]+)/g)].map((m) => m[1]));
if (!appVer) fail("app.js 里找不到 APP_VERSION");
const versions = new Set([...htmlVers, ...swVers, appVer ? appVer[1] : ""]);
if (versions.size !== 1) {
  fail(`版本号不一致：index.html=${[...htmlVers].join("/") || "无"}  sw.js=${[...swVers].join("/") || "无"}  app.js=${appVer ? appVer[1] : "无"}`);
} else {
  console.log(`  版本号三处一致：v${[...versions][0]}`);
}

for (const rel of [".nojekyll", ".gitignore"]) {
  if (!fs.existsSync(path.join(APP, rel))) fail(`缺少 ${rel}（GitHub Pages 发布需要）`);
}

// 发布前自检：确认私钥没有被放进要公开的目录
function scanKeys(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { scanKeys(full); continue; }
    if (/\.(pem|key|p12|pfx)$/i.test(entry.name)) fail(`公开目录里发现密钥类文件：${path.relative(APP, full)}`);
    if (/\.crx$/i.test(entry.name)) fail(`公开目录里发现打包产物：${path.relative(APP, full)}`);
  }
}
scanKeys(APP);

// 样式与主脚本的存在性
for (const rel of ["app.css", "vendor/xlsx.full.min.js"]) {
  if (!fs.existsSync(path.join(APP, rel))) fail(`缺少 ${rel}`);
}

/* ---------------------------------------------------------------- 汇总 */

console.log("");
console.log(`题库合计：${grandTotal} 题，${banks.length} 个题库`);
if (notes.length) {
  console.log("提示：");
  for (const n of notes) console.log(`  - ${n}`);
}
if (failures.length) {
  console.log("校验失败：");
  for (const f of failures) console.log(`  !! ${f}`);
  process.exit(1);
}
console.log("校验通过：题库、脚本、页面与清单均一致。");
