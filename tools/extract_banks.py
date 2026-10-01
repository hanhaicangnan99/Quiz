# -*- coding: utf-8 -*-
"""从离线答题 HTML / xlsx / csv 中提取题库，生成 Chrome 侧载 App 用的 banks/*.js。

用法（在 乙烯答题App 目录下）：
    python tools\\extract_banks.py

数据来源默认为工作区里既有的 5 个「离线答题系统」HTML 文件（每题单行的
`var BANK_DATA = [ ... ];`）。脚本会：
  1) 解析出题库数组；
  2) 统一字段（id / type / question / options / answer / explanation / subject）；
  3) 写出 banks/<id>.js 与 banks/index.js；
  4) 在 tools/extract-report.txt 里输出统计与异常清单，便于人工核对。
"""

from __future__ import print_function

import datetime
import html
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
WORKSPACE = os.path.dirname(APP_DIR)
BANKS_DIR = os.path.join(APP_DIR, "banks")
REPORT = os.path.join(HERE, "extract-report.txt")

# 题库注册表：顺序即 App 里的显示顺序
BANKS = [
    {
        "id": "wf",
        "name": "危害因素辨识与风险防控",
        "group": "竞赛题库",
        "src": "危害因素辨识与风险防控_离线答题系统.html",
        "desc": "危害因素辨识与风险防控（安全类，判断题为主）",
    },
    {
        "id": "cx",
        "name": "程序文件题库",
        "group": "竞赛题库",
        "src": os.path.join("程序文件", "程序文件题库_合并_离线答题系统.html"),
        "desc": "公司管理规定/程序文件合并题库（可按科目筛选）",
    },
    {
        "id": "rd-zj",
        "name": "认定题库 · 中级",
        "group": "技能认定",
        "src": os.path.join("乙烯装置操作工认定题库2022", "认定题库-中级-答题系统.html"),
        "desc": "乙烯装置操作工认定题库（中级）",
    },
    {
        "id": "rd-gj",
        "name": "认定题库 · 高级",
        "group": "技能认定",
        "src": os.path.join("乙烯装置操作工认定题库2022", "认定题库-高级-答题系统.html"),
        "desc": "乙烯装置操作工认定题库（高级）",
    },
    {
        "id": "rd-js",
        "name": "认定题库 · 技师",
        "group": "技能认定",
        "src": os.path.join("乙烯装置操作工认定题库2022", "认定题库-技师-答题系统.html"),
        "desc": "乙烯装置操作工认定题库（技师）",
    },
]

JUDGE_TRUE = {"A", u"对", u"正确", u"是", u"TRUE", u"T", u"Y", u"YES", u"√", u"1"}
JUDGE_FALSE = {"B", u"错", u"错误", u"否", u"FALSE", u"F", u"N", u"NO", u"×", u"X", u"0"}
ENTITY_RE = re.compile(r"&(#\d+|#x[0-9a-fA-F]+|nbsp|amp|lt|gt|quot|apos|ldquo|rdquo|hellip|middot|times);")
# 题库里混入了 PDF 转换残留的 XML/HTML 标签（<P>、<img ...>、<span ...> 等）
TAG_RE = re.compile(u"<[A-Za-z/][^<>]*>")
TAG_TAIL_RE = re.compile(u"<[A-Za-z/][^<>]*$")
IMG_RE = re.compile(u"<img\\b[^<>]*>", re.IGNORECASE)
MAX_UNESCAPE_PASSES = 3


# ---------------------------------------------------------------- 读取与解析


def read_text(path):
    with io.open(path, "r", encoding="utf-8-sig", errors="strict") as f:
        return f.read()


def extract_bank_data(text):
    """定位 `var BANK_DATA = [ ... ];` 并按括号配对取出数组。"""
    key = "var BANK_DATA = ["
    pos = text.find(key)
    if pos < 0:
        raise ValueError("未找到 var BANK_DATA = [")
    start = pos + len("var BANK_DATA = ")
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                raw = text[start:i + 1]
                return json.loads(raw)
    raise ValueError("题库数组未正常结束")


# ---------------------------------------------------------------- 字段归一


def clean_field(value, notes, ws_counter):
    """清理一个文本字段：反复解码 HTML 实体（数据里存在双重/三重转义），
    去掉 PDF 转换残留的标签（图片标签替换为【图】），最后压缩空白。
    只有「结构性」改动（实体/标签）才逐条记录，纯空白归一计入 ws_counter。"""
    if not isinstance(value, str) or not value:
        return u""
    original = value
    text = value
    structural = False
    for _ in range(MAX_UNESCAPE_PASSES):
        if not ENTITY_RE.search(text):
            break
        decoded = html.unescape(text)
        if decoded == text:
            break
        text = decoded
        structural = True
    if IMG_RE.search(text):
        text = IMG_RE.sub(u"\u3010\u56fe\u3011", text)
        structural = True
    if TAG_RE.search(text):
        text = TAG_RE.sub(u" ", text)
        structural = True
    if TAG_TAIL_RE.search(text):
        text = TAG_TAIL_RE.sub(u"", text)
        structural = True
    collapsed = re.sub(r"\s+", u" ", text).strip()
    if structural:
        notes.append((original, collapsed))
        src_len = len(original.strip())
        if src_len >= 40 and len(collapsed) < src_len * 0.5:
            notes.append((u"\u26a0 清理后长度缩短超过一半（请人工复核）",
                          u"%s → %s" % (original[:60], collapsed[:60])))
    elif collapsed != original.strip():
        ws_counter[0] += 1
    return collapsed


def norm_type(raw):
    t = re.sub(r"\s+", "", (raw or u""))
    if u"判断" in t:
        return u"判断题"
    if u"多选" in t:
        return u"多选题"
    if u"单选" in t or u"单项" in t or u"选择" in t:
        return u"单选题"
    if u"填空" in t:
        return u"填空题"
    if u"简答" in t or u"问答" in t:
        return u"简答题"
    return t


def norm_text(raw):
    return re.sub(r"\s+", u" ", (raw or u"")).strip()


def norm_answer_choice(raw):
    up = norm_text(raw).upper()
    letters = sorted(set(re.findall(r"[A-F]", up)))
    return u"".join(letters)


def norm_judge(raw):
    v = norm_text(raw).upper()
    if v in JUDGE_TRUE:
        return "A"
    if v in JUDGE_FALSE:
        return "B"
    return norm_answer_choice(v)


def norm_options(raw_options, qtype):
    opts = []
    if isinstance(raw_options, list):
        for item in raw_options:
            if not isinstance(item, dict):
                continue
            key = norm_text(item.get("key", u"")).upper()[:1]
            text = norm_text(item.get("text", u""))
            if not key and not text:
                continue
            opts.append({"key": key, "text": text})
    # 判断题固定为「对 / 错」
    if qtype == u"判断题":
        return [{"key": "A", "text": u"对"}, {"key": "B", "text": u"错"}]
    return [o for o in opts if o["text"]]


def normalize_question(raw, index, issues, ws_counter):
    qtype = norm_type(raw.get("type"))
    notes = []
    question = clean_field(raw.get("question"), notes, ws_counter)
    explanation = clean_field(raw.get("explanation"), notes, ws_counter)
    subject = clean_field(raw.get("subject"), notes, ws_counter)
    raw_answer = clean_field(raw.get("answer", u""), notes, ws_counter)

    options = norm_options(raw.get("options"), qtype)
    options = [{"key": o["key"], "text": clean_field(o["text"], notes, ws_counter)} for o in options]

    if not qtype:
        if options and [o["text"] for o in options] == [u"对", u"错"]:
            qtype = u"判断题"
        elif len(options) >= 2:
            qtype = u"单选题"
        else:
            qtype = u"简答题"
        issues.append(u"题型为空，按选项推断为 %s：%s" % (qtype, question[:30]))

    if qtype == u"判断题":
        answer = norm_judge(raw_answer)
        options = [{"key": "A", "text": u"对"}, {"key": "B", "text": u"错"}]
    elif qtype in (u"填空题", u"简答题", u"计算题"):
        answer = raw_answer
        options = []
    else:
        answer = norm_answer_choice(raw_answer)
        if not answer:
            answer = raw_answer
            issues.append(u"选择题答案无法归一：%s" % question[:30])

    qid = norm_text(raw.get("id", u""))
    if not qid:
        qid = u"%04d" % (index + 1)
    elif re.match(r"^\d+$", qid):
        qid = qid.zfill(4)

    item = {
        "id": qid,
        "type": qtype,
        "question": question,
        "options": options,
        "answer": answer,
        "explanation": explanation,
    }
    if subject:
        item["subject"] = subject
    for pair in notes:
        issues.append(u"文本已清理：%s → %s" % (pair[0][:80], pair[1][:80]))
    return item


# ---------------------------------------------------------------- 校验与统计


def audit(bank):
    qs = bank["questions"]
    stats = {
        "total": len(qs),
        "types": {},
        "subjects": {},
        "dupIds": [],
        "emptyQuestion": [],
        "answerNotInOptions": [],
        "noOptions": [],
        "dupQuestionText": [],
    }
    seen_ids = {}
    seen_text = {}
    for q in qs:
        stats["types"][q["type"]] = stats["types"].get(q["type"], 0) + 1
        if q.get("subject"):
            stats["subjects"][q["subject"]] = stats["subjects"].get(q["subject"], 0) + 1
        if q["id"] in seen_ids:
            stats["dupIds"].append(q["id"])
        seen_ids[q["id"]] = 1
        if not q["question"]:
            stats["emptyQuestion"].append(q["id"])
        text_key = q["question"]
        if text_key:
            seen_text[text_key] = seen_text.get(text_key, 0) + 1
        if q["type"] in (u"单选题", u"多选题"):
            keys = set(o["key"] for o in q["options"])
            if not keys:
                stats["noOptions"].append(q["id"])
            else:
                for letter in q["answer"]:
                    if letter not in keys:
                        stats["answerNotInOptions"].append((q["id"], q["answer"], u"".join(sorted(keys))))
                        break
        if q["type"] == u"判断题" and q["answer"] not in ("A", "B"):
            stats["answerNotInOptions"].append((q["id"], q["answer"], u"A/B"))
    stats["dupQuestionText"] = [k for k, v in seen_text.items() if v > 1]
    return stats


def js_string(obj):
    """把对象转成可安全内嵌到 <script> 里的 JSON 字面量。"""
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    text = text.replace(u"</", u"<\\/")
    text = text.replace(u"\u2028", u"\\u2028").replace(u"\u2029", u"\\u2029")
    return text


# ---------------------------------------------------------------- 输出


def write_bank_file(bank):
    path = os.path.join(BANKS_DIR, bank["id"] + ".js")
    payload = {
        "id": bank["id"],
        "name": bank["name"],
        "group": bank["group"],
        "desc": bank["desc"],
        "source": bank["src"].replace("\\", "/"),
        "builtAt": bank["builtAt"],
        "questions": bank["questions"],
    }
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(u"/* 由 tools/extract_banks.py 自动生成，请勿手工编辑。\n")
        f.write(u"   来源：%s */\n" % bank["src"].replace("\\", "/"))
        f.write(u"window.YXA = window.YXA || { banks: [] };\n")
        f.write(u"window.YXA.banks.push(%s);\n" % js_string(payload))
    return path


def write_index_file(banks, built_at):
    path = os.path.join(BANKS_DIR, "index.js")
    order = [b["id"] for b in banks]
    meta = {
        "appName": u"乙烯答题练习",
        "version": "1.0.0",
        "builtAt": built_at,
    }
    lines = [
        u"/* 由 tools/extract_banks.py 自动生成，请勿手工编辑。 */",
        u"window.YXA = window.YXA || { banks: [] };",
        u"window.YXA.ORDER = %s;" % js_string(order),
        u"window.YXA.META = %s;" % js_string(meta),
        u"",
    ]
    for b in banks:
        lines.append(u"// %s  %s  %d 题" % (b["id"].ljust(7), b["name"], len(b["questions"])))
    lines.append(u"")
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(u"\n".join(lines))
    return path


def main():
    if not os.path.isdir(BANKS_DIR):
        os.makedirs(BANKS_DIR)

    built_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    report = []
    report.append(u"题库提取报告  %s" % built_at)
    report.append(u"工作区：%s" % WORKSPACE)
    report.append(u"=" * 78)

    done = []
    problems = 0
    for spec in BANKS:
        src_path = os.path.join(WORKSPACE, spec["src"])
        report.append(u"")
        report.append(u"● %s  (%s)" % (spec["name"], spec["id"]))
        report.append(u"  来源：%s" % spec["src"])
        if not os.path.isfile(src_path):
            report.append(u"  !! 源文件不存在，跳过")
            problems += 1
            continue

        text = read_text(src_path)
        raw_list = extract_bank_data(text)
        issues = []
        ws_counter = [0]
        questions = [normalize_question(raw, i, issues, ws_counter) for i, raw in enumerate(raw_list)]

        bank = dict(spec)
        bank["questions"] = questions
        bank["builtAt"] = built_at
        stats = audit(bank)

        report.append(u"  %s 中解析到 %d 题，归一后 %d 题"
                      % (os.path.basename(spec["src"]), len(raw_list), stats["total"]))
        report.append(u"  题型分布：%s" % u"、".join(
            u"%s %d" % (k, v) for k, v in sorted(stats["types"].items(), key=lambda kv: -kv[1])))
        if stats["subjects"]:
            report.append(u"  科目数：%d" % len(stats["subjects"]))
            for name, cnt in sorted(stats["subjects"].items(), key=lambda kv: (-kv[1], kv[0])):
                report.append(u"    - %s：%d" % (name, cnt))
        if stats["dupIds"]:
            report.append(u"  !! 重复 id %d 个：%s" % (len(stats["dupIds"]), u", ".join(stats["dupIds"][:10])))
            problems += 1
        if stats["emptyQuestion"]:
            report.append(u"  !! 空题干 %d 个：%s" % (len(stats["emptyQuestion"]),
                                                  u", ".join(stats["emptyQuestion"][:10])))
            problems += 1
        if stats["noOptions"]:
            report.append(u"  !! 选择题缺选项 %d 个：%s" % (len(stats["noOptions"]),
                                                     u", ".join(stats["noOptions"][:10])))
            problems += 1
        if stats["answerNotInOptions"]:
            report.append(u"  !! 答案与选项不匹配 %d 个（最多列 8 条）：" % len(stats["answerNotInOptions"]))
            for qid, ans, keys in stats["answerNotInOptions"][:8]:
                report.append(u"     id=%s 答案=%s 选项键=%s" % (qid, ans, keys))
            problems += 1
        if stats["dupQuestionText"]:
            report.append(u"  ** 题干重复 %d 组（仅提示，不阻断）：%s"
                          % (len(stats["dupQuestionText"]),
                             u" / ".join(t[:24] for t in stats["dupQuestionText"][:5])))
        if ws_counter[0]:
            report.append(u"  ** 另有 %d 处仅做空白/全角空格归一（与原版 App 渲染时 clean() 的结果一致）"
                          % ws_counter[0])
        if issues:
            report.append(u"  ** 文本清理提示 %d 条（实体解码/标签去除，最多列 6 条）：" % len(issues))
            for line in issues[:6]:
                report.append(u"     %s" % line)

        out = write_bank_file(bank)
        report.append(u"  已写出：%s" % os.path.relpath(out, WORKSPACE))
        done.append(bank)

    idx = write_index_file(done, built_at)
    report.append(u"")
    report.append(u"=" * 78)
    report.append(u"已写出题库索引：%s" % os.path.relpath(idx, WORKSPACE))
    report.append(u"合计：%d 个题库，%d 题" % (len(done), sum(len(b["questions"]) for b in done)))
    report.append(u"需要人工确认的问题项：%d" % problems)

    with io.open(REPORT, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(u"\n".join(report) + u"\n")

    summary = "banks written: %d, questions: %d, problems: %d, report: %s" % (
        len(done), sum(len(b["questions"]) for b in done), problems,
        os.path.relpath(REPORT, WORKSPACE))
    try:
        print(summary)
    except UnicodeEncodeError:
        print(summary.encode("ascii", "replace").decode("ascii"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
