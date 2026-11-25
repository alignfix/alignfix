# py/review.py
"""
Review: sentence pairs and words that look like translation errors.

Built on issues.py: a sentence pair has an issue when a word lacks every one of
its usual translations on the other side although it nearly always has one,
when numbers differ, when the target repeats itself, has an unusual length or
copies the source. Words that are just translated in several valid ways
(synonyms, inflections, paraphrases) are not flagged.

Severity of a sentence pair by its issue score (issues.issue_score):
    high    >= HIGH_SCORE
    medium  >= MEDIUM_SCORE
    low     > 0

On a real German-Italian corpus with 2% injected errors, 30% of the high pairs
were injected errors (most of the rest real mismatches), against 2% at random.

Sentence pairs a person checked can be marked OK: they stay out of the list
(status "open") until the text of the pair changes. Words are confirmed by
adding them with their translations to the glossary (glossary.py): they leave
the words list, their confirmed translations count as usual translations, and
a pair with a glossary term but none of its confirmed translations on the
other side is flagged.

Results are cached per project until the sentences or the hide list change.
The phrase table (phrase_table) summarises the extracted phrase pairs per
source phrase, for export.
"""
import hashlib
import math
from collections import Counter, defaultdict

from db import get_db
from issues import IssueModel, sentence_issues, issue_score, describe, KIND_LABELS, _NUMBER, _words
from issues import stem
from text import NO_BLANK_TOKEN, BLANK_TOKEN
import glossary
import progress

HIGH_SCORE = 6.0
MEDIUM_SCORE = 3.0
LEVELS = {"high": HIGH_SCORE, "medium": MEDIUM_SCORE, "low": 1e-9}
EXAMPLES_PER_WORD = 20
WORD_MIN_LIFT = 1.0       # nats above the surprise threshold, see issues.IssueModel.lift

_cache = {}               # project_id -> (signature, analysis)


def _entropy(counts):
    total = sum(counts)
    if not total:
        return 0.0
    return max(0.0, -sum(c / total * math.log2(c / total) for c in counts if c))


def level(score):
    if score >= HIGH_SCORE:
        return "high"
    if score >= MEDIUM_SCORE:
        return "medium"
    return "low" if score > 0 else None


def _signature(cursor, project_id):
    """Changes whenever sentences or alignments change."""
    cursor.execute(
        "SELECT COUNT(*), MAX(row_id), TOTAL(LENGTH(alignment)), TOTAL(LENGTH(line1) + LENGTH(line2)), "
        "MAX(updated_at) FROM alignments WHERE project_id=? AND deleted_at IS NULL", (project_id,))
    return cursor.fetchone()


def text_hash(line1, line2):
    return hashlib.sha1(f"{line1 or ''}\t{line2 or ''}".encode("utf-8")).hexdigest()[:16]


GLOSSARY_SURPRISE = 3.0   # a missing glossary translation alone makes a pair "medium"


def _ok_rows(cursor, project_id):
    """{row_id: text hash} of the pairs marked OK."""
    cursor.execute("SELECT row_id, text_hash FROM review_marks WHERE project_id=? AND status='ok'", (project_id,))
    return dict(cursor.fetchall())


def _hidden_words(cursor, project_id):
    """{'src': set, 'tgt': set} of single words hidden whatever their translation."""
    cursor.execute("SELECT src_phrase, tgt_phrase FROM ignored WHERE project_id=?", (project_id,))
    hidden = {"src": set(), "tgt": set()}
    for src, tgt in cursor.fetchall():
        src, tgt = (src or "").strip(), (tgt or "").strip()
        if src and not tgt and " " not in src:
            hidden["src"].add(src.casefold())
        elif tgt and not src and " " not in tgt:
            hidden["tgt"].add(tgt.casefold())
    return hidden


async def _check_all(project_id, cursor):
    """All issues of all sentence pairs (slow; cached until the sentences change)."""
    sig = _signature(cursor, project_id)
    cached = _cache.get(project_id)
    if cached and cached[0] == sig:
        return cached[1]

    with progress.stage(0.0, 0.05, "Loading sentences"):
        cursor.execute("SELECT row_id, line1, line2, alignment FROM alignments "
                       "WHERE project_id=? AND deleted_at IS NULL ORDER BY row_id", (project_id,))
        rows = cursor.fetchall()
    model = await progress.drive(
        IssueModel.build_steps((line1, line2, al) for _, line1, line2, al in rows),
        0.05, 0.6, "Learning the usual translations")
    checked = []
    with progress.stage(0.6, 1.0, "Checking sentences"):
        n = len(rows) or 1
        for i, (row_id, line1, line2, _) in enumerate(rows):
            if i % 2000 == 0:
                await progress.checkpoint(i / n, f"{i:,} / {len(rows):,} sentences")
            found = sentence_issues(model, line1, line2)
            if found:
                checked.append((row_id, found, text_hash(line1, line2)))
    raw = {"model": model, "checked": len(rows), "found": checked}
    _cache[project_id] = (sig, raw)
    _views.pop(project_id, None)
    return raw


_views = {}               # project_id -> (raw, hidden key, analysis)


async def analyse(project_id):
    """
    {'sentences': [{row_id, score, level, issues}], 'checked': n, 'words': {(side, word): {...}}}:
    sentences with issues only, most severe first, without the hidden words.
    """
    _, cursor = get_db()
    raw = await _check_all(project_id, cursor)
    hidden = _hidden_words(cursor, project_id)
    terms = glossary.terms(project_id)
    key = (frozenset(hidden["src"]), frozenset(hidden["tgt"]),
           frozenset((k, frozenset(v)) for k, v in terms["src"].items()))
    view = _views.get(project_id)
    if view and view[0] is raw and view[1] == key:
        return view[2]

    model = raw["model"]
    found_by_row = {row_id: (found, hashed) for row_id, found, hashed in raw["found"]}
    confirmed = {"src": {k[0]: {stem(w) for t in v for w in t} for k, v in terms["src"].items() if len(k) == 1},
                 "tgt": {k[0]: {stem(w) for t in v for w in t} for k, v in terms["tgt"].items() if len(k) == 1}}
    if terms["src"]:
        found_by_row = await _apply_glossary(project_id, cursor, terms, confirmed, found_by_row)

    sentences = []
    words = {}
    for row_id, (found, hashed) in sorted(found_by_row.items()):
        found = [f for f in found
                 if not (f["kind"] in ("missing", "unexplained") and f["word"] in hidden[f["side"]])]
        if not found:
            continue
        score = issue_score(found)
        sentences.append({"row_id": row_id, "score": score, "level": level(score), "issues": found, "hash": hashed})
        for f in found:
            # the words list only counts clear cases: function words, whose translations
            # appear almost everywhere, are missed often but say little each time
            if f["kind"] not in ("missing", "unexplained") or f["lift"] < WORD_MIN_LIFT:
                continue
            if f["word"] in confirmed[f["side"]]:
                continue   # confirmed in the glossary: reviewed
            key_w = (f["side"], f["word"])
            entry = words.get(key_w)
            if entry is None:
                model_side = model.src if f["side"] == "src" else model.tgt
                entry = words[key_w] = {
                    "side": f["side"], "word": f["word"], "kind": f["kind"],
                    "flagged": 0, "sentences": model_side.sentences.get(f["word"], 0),
                    "rate": f["rate"], "expected": f["expected"], "severity": 0.0, "examples": [],
                }
            entry["flagged"] += 1
            entry["severity"] += f["lift"]
            entry["examples"].append((score, row_id))

    sentences.sort(key=lambda r: (-r["score"], r["row_id"]))
    for entry in words.values():
        entry["examples"] = [row_id for _, row_id in sorted(entry["examples"], key=lambda x: (-x[0], x[1]))[:EXAMPLES_PER_WORD]]
        entry["severity"] = round(entry["severity"], 3)
    analysis = {"sentences": sentences, "checked": raw["checked"], "words": words, "glossary": terms}
    _views[project_id] = (raw, key, analysis)
    return analysis


def _term_positions(tokens, terms):
    """[(start, term)] of the glossary terms (token tuples) occurring in tokens."""
    by_first = defaultdict(list)
    for term in terms:
        by_first[term[0]].append(term)
    hits = []
    for i, tok in enumerate(tokens):
        for term in by_first.get(tok, ()):
            if tuple(tokens[i:i + len(term)]) == term:
                hits.append((i, term))
    return hits


async def _apply_glossary(project_id, cursor, terms, confirmed, found_by_row):
    """
    found_by_row with the glossary applied: issues of words whose confirmed
    translation is on the other side are dropped, and glossary terms without
    any confirmed translation on the other side are added as issues.
    """
    cursor.execute("SELECT row_id, line1, line2 FROM alignments WHERE project_id=? AND deleted_at IS NULL "
                   "ORDER BY row_id", (project_id,))
    rows = cursor.fetchall()
    out = {}
    n = len(rows) or 1
    for i, (row_id, line1, line2) in enumerate(rows):
        if i % 5000 == 0:
            await progress.checkpoint(i / n, f"glossary: {i:,} / {len(rows):,} sentences")
        toks = {"src": [t.casefold() for t in (line1 or "").split()],
                "tgt": [t.casefold() for t in (line2 or "").split()]}
        stems = {side: {stem(t) for t in toks[side]} for side in toks}
        found, hashed = found_by_row.get(row_id, ([], None))
        kept = []
        for f in found:
            other = "tgt" if f["side"] == "src" else "src"
            ok = confirmed[f["side"]].get(f["word"])
            if f["kind"] in ("missing", "unexplained") and ok and not ok.isdisjoint(stems[other]):
                continue
            kept.append(f)
        for side, other in (("src", "tgt"), ("tgt", "src")):
            for start, term in _term_positions(toks[side], terms[side]):
                partners = terms[side][term]
                # a partner counts when all of its words appear (inflections: by stem)
                if any(all(stem(w) in stems[other] for w in partner) for partner in partners):
                    continue
                kept.append({
                    "side": side, "index": start, "length": len(term), "word": " ".join(term),
                    "kind": "glossary", "anomaly": GLOSSARY_SURPRISE, "rate": None, "lift": 0.0,
                    "expected": sorted(" ".join(p) for p in partners), "repeat": False,
                })
        # a glossary issue replaces the statistical one for the same word (no double counting)
        glossed = {(f["side"], f["word"]) for f in kept if f["kind"] == "glossary"}
        kept = [f for f in kept if f["kind"] == "glossary"
                or not (f["kind"] in ("missing", "unexplained") and (f["side"], f["word"]) in glossed)]
        if kept:
            out[row_id] = (kept, hashed or text_hash(line1, line2))
    return out


def _segments(line, flagged):
    """Detokenised display of a tokenised line: [[text, flagged], ...], separators included."""
    out = []
    glue = True
    for i, tok in enumerate((line or "").split()):
        if tok == NO_BLANK_TOKEN:
            glue = True
            continue
        if tok == BLANK_TOKEN:
            glue = False
            continue
        if not glue:
            out.append([" ", False])
        out.append([tok, i in flagged])
        glue = False
    return out


def _flagged_positions(line, words):
    """Token positions whose normalised form is in `words` (for numbers: contains it)."""
    found = set()
    for i, tok in enumerate((line or "").split()):
        if tok.lower() in words or any(n.replace(",", ".") in words for n in _NUMBER.findall(tok)):
            found.add(i)
    return found


def _load_rows(cursor, project_id, row_ids):
    if not row_ids:
        return {}
    marks = ",".join("?" * len(row_ids))
    cursor.execute(f"SELECT row_id, line1, line2 FROM alignments WHERE project_id=? AND row_id IN ({marks})",
                   (project_id, *row_ids))
    return {r[0]: (r[1], r[2]) for r in cursor.fetchall()}


def _sentence_view(row, line1, line2):
    src_words = {f["word"] for f in row["issues"] if f["side"] == "src" and f["word"] and f["kind"] == "number"}
    tgt_words = {f["word"] for f in row["issues"] if f["side"] == "tgt" and f["word"] and f["kind"] == "number"}
    def positions(side):
        return {f["index"] + k for f in row["issues"] if f["side"] == side and f["index"] is not None
                for k in range(f.get("length", 1))}
    src_pos, tgt_pos = positions("src"), positions("tgt")
    src_pos |= _flagged_positions(line1, {w for w in src_words if w[:1].isdigit()})
    tgt_pos |= _flagged_positions(line2, {w for w in tgt_words if w[:1].isdigit()})
    # most words without a counterpart: the two sides probably do not belong together
    mismatch = False
    for side, line in (("src", line1), ("tgt", line2)):
        checked = len(_words(line))
        flagged = sum(1 for f in row["issues"] if f["side"] == side and f["kind"] in ("missing", "unexplained"))
        if flagged >= 4 and flagged >= 0.4 * checked:
            mismatch = True
    return {
        "row_id": row["row_id"],
        "ok": bool(row.get("ok")),
        "score": row["score"],
        "level": row["level"],
        "mismatch": mismatch,
        "src": _segments(line1, src_pos),
        "tgt": _segments(line2, tgt_pos),
        "issues": [{"side": f["side"], "word": f["word"], "kind": f["kind"],
                    "label": KIND_LABELS[f["kind"]], "text": describe(f),
                    "anomaly": round(f["anomaly"], 2)} for f in row["issues"]],
    }


def _summary(analysis, sentences, ok_count=0, glossary_terms=0):
    by_level = Counter(r["level"] for r in sentences)
    kinds = defaultdict(Counter)       # kind -> level -> sentences
    for r in sentences:
        for kind in {f["kind"] for f in r["issues"]}:
            kinds[kind][r["level"]] += 1
    top_words = sorted(analysis["words"].values(), key=lambda w: (-w["severity"], w["word"]))[:10]
    return {
        "checked": analysis["checked"],
        "high": by_level["high"], "medium": by_level["medium"], "low": by_level["low"],
        "words": sum(1 for w in analysis["words"].values() if w["flagged"]),
        "kinds": [[kind, KIND_LABELS[kind], kinds[kind]["high"], kinds[kind]["medium"], kinds[kind]["low"]]
                  for kind in KIND_LABELS if kinds[kind]],
        "top_words": [[w["side"], w["word"], w["flagged"]] for w in top_words],
        "thresholds": {"high": HIGH_SCORE, "medium": MEDIUM_SCORE},
        "ok": ok_count,
        "glossary_terms": glossary_terms,
    }


STATUSES = ("open", "ok", "all")


async def _filtered(project_id, view, search, min_level, kind, side, status):
    """(analysis, rows, summary): the sentence pairs or words matching the filters, in list order."""
    analysis = await analyse(project_id)
    _, cursor = get_db()
    needle = (search or "").strip().casefold()
    threshold = LEVELS.get(min_level, MEDIUM_SCORE)
    status = status if status in STATUSES else "open"

    marks = _ok_rows(cursor, project_id)
    for r in analysis["sentences"]:
        r["ok"] = marks.get(r["row_id"]) == r["hash"]
    open_rows = [r for r in analysis["sentences"] if not r["ok"]]
    terms = analysis["glossary"]
    confirmed = [{"side": side, "word": " ".join(term), "ok": True, "flagged": 0, "sentences": 0, "rate": None,
                  "expected": sorted(" ".join(p) for p in partners), "severity": 0.0}
                 for side in ("src", "tgt") for term, partners in terms[side].items()]
    confirmed.sort(key=lambda w: (w["word"], w["side"]))
    summary = _summary(analysis, open_rows, len(analysis["sentences"]) - len(open_rows), len(terms["src"]))

    if view == "words":
        if status == "ok":
            rows = confirmed
        else:
            rows = [dict(w, ok=False) for w in analysis["words"].values()]
            rows.sort(key=lambda w: (-w["severity"], -w["flagged"], w["word"]))
            if status == "all":
                rows += confirmed
        if side:
            rows = [w for w in rows if w["side"] == side]
        if needle:
            rows = [w for w in rows if needle in w["word"] or any(needle in e for e in w["expected"])]
        return analysis, rows, summary

    rows = {"open": open_rows, "ok": [r for r in analysis["sentences"] if r["ok"]],
            "all": analysis["sentences"]}[status]
    rows = [r for r in rows if r["score"] >= threshold]
    if kind:
        rows = [r for r in rows if any(f["kind"] == kind for f in r["issues"])]
    if side:
        rows = [r for r in rows if any(f["side"] == side for f in r["issues"])]
    if needle:
        hits = []
        texts = _load_rows(cursor, project_id, [r["row_id"] for r in rows]) if rows else {}
        for r in rows:
            line1, line2 = texts.get(r["row_id"], ("", ""))
            if (needle in (line1 or "").casefold() or needle in (line2 or "").casefold()
                    or any(needle in f["word"] for f in r["issues"])):
                hits.append(r)
        rows = hits
    return analysis, rows, summary


async def review_overview(project_id, view="sentences", start=0, length=25, search="",
                          min_level="medium", kind="", side="", status="open"):
    """One page of the sentence or word list, plus the summary of the whole project."""
    analysis, rows, summary = await _filtered(project_id, view, search, min_level, kind, side, status)
    start, length = max(0, int(start or 0)), max(1, min(200, int(length or 25)))
    page = rows[start:start + length]
    if view == "words":
        page = [{k: v for k, v in w.items() if k != "examples"} for w in page]
        return {"view": "words", "filtered": len(rows), "rows": page, "summary": summary}
    _, cursor = get_db()
    texts = _load_rows(cursor, project_id, [r["row_id"] for r in page])
    return {
        "view": "sentences",
        "filtered": len(rows),
        "rows": [_sentence_view(r, *texts.get(r["row_id"], ("", ""))) for r in page],
        "summary": summary,
    }


async def review_export(project_id, view="sentences", search="", min_level="medium", kind="", side="",
                        status="open"):
    """Every entry matching the filters, as plain records for a CSV or JSON file."""
    from text import detokenise
    analysis, rows, _ = await _filtered(project_id, view, search, min_level, kind, side, status)
    if view == "words":
        return [{"side": w["side"], "word": w["word"], "status": "ok" if w["ok"] else "open",
                 "without_translation": w["flagged"], "sentences": w["sentences"],
                 "usually_translated": None if w["rate"] is None else round(w["rate"], 4),
                 "usual_translations": " | ".join(w["expected"])} for w in rows]
    _, cursor = get_db()
    out = []
    ids = [r["row_id"] for r in rows]
    texts = {}
    for i in range(0, len(ids), 500):
        texts.update(_load_rows(cursor, project_id, ids[i:i + 500]))
    for r in rows:
        line1, line2 = texts.get(r["row_id"], ("", ""))
        out.append({
            "line": r["row_id"] + 1, "level": r["level"], "score": round(r["score"], 3),
            "status": "ok" if r["ok"] else "open",
            "issues": "; ".join(describe(f) for f in r["issues"]),
            "source": detokenise(line1 or ""), "target": detokenise(line2 or ""),
        })
    return out


def mark_pairs(project_id, row_ids, ok=True):
    """Mark sentence pairs OK (for their current text), or remove the mark. Returns the number changed."""
    conn, cursor = get_db()
    row_ids = [int(r) for r in row_ids]
    if not ok:
        for r in row_ids:
            cursor.execute("DELETE FROM review_marks WHERE project_id=? AND row_id=?", (project_id, r))
        conn.commit()
        return len(row_ids)
    texts = {}
    for i in range(0, len(row_ids), 500):
        texts.update(_load_rows(cursor, project_id, row_ids[i:i + 500]))
    cursor.executemany(
        "INSERT OR REPLACE INTO review_marks (project_id, row_id, status, text_hash, created_at) "
        "VALUES (?, ?, 'ok', ?, CURRENT_TIMESTAMP)",
        [(project_id, r, text_hash(*texts[r])) for r in row_ids if r in texts])
    conn.commit()
    return sum(1 for r in row_ids if r in texts)


async def mark_all(project_id, search="", min_level="medium", kind="", side="", ok=True):
    """Mark every open pair matching the filters OK (or every OK pair open again)."""
    _, rows, _ = await _filtered(project_id, "sentences", search, min_level, kind, side, "open" if ok else "ok")
    return mark_pairs(project_id, [r["row_id"] for r in rows], ok)


async def word_examples(project_id, side, word):
    """The flagged sentence pairs of one word (most severe first), for the detail pane."""
    analysis = await analyse(project_id)
    entry = analysis["words"].get((side, word))
    if not entry:
        return {"word": None, "rows": []}
    by_id = {r["row_id"]: r for r in analysis["sentences"]}
    _, cursor = get_db()
    texts = _load_rows(cursor, project_id, entry["examples"])
    rows = [_sentence_view(by_id[i], *texts[i]) for i in entry["examples"] if i in by_id and i in texts]
    return {"word": {k: v for k, v in entry.items() if k != "examples"}, "rows": rows}


# ------------------------------------------------------------------ phrase table

def phrase_table(project_id, min_total=1, top_k=5, include_hidden=False):
    """
    The extracted phrase pairs summarised per source phrase: total sentences,
    top translation and its share, number of translations, entropy (bits) and
    the top_k translations. Directions are merged.
    """
    from text import detokenise
    _, cursor = get_db()
    cond = "" if include_hidden else " AND ignore=0"
    cursor.execute("SELECT src_phrase, tgt_phrase, SUM(num_occurrences) FROM phrases "
                   f"WHERE project_id=? AND num_occurrences > 0{cond} "
                   "GROUP BY src_phrase, tgt_phrase", (project_id,))
    groups = defaultdict(list)
    for src, tgt, count in cursor.fetchall():
        groups[src].append((tgt, int(count)))
    table = []
    for src, translations in groups.items():
        translations.sort(key=lambda x: (-x[1], x[0]))
        total = sum(c for _, c in translations)
        if total < min_total:
            continue
        top_tgt, top_count = translations[0]
        table.append({
            "src": detokenise(src),
            "total": total,
            "top_tgt": detokenise(top_tgt),
            "top_share": round(top_count / total, 4),
            "num_tgts": len(translations),
            "entropy": round(_entropy([c for _, c in translations]), 4),
            "alternatives": [{"tgt": detokenise(t), "count": c, "share": round(c / total, 4)}
                             for t, c in translations[:top_k]],
        })
    table.sort(key=lambda r: (-r["total"], r["src"]))
    return table
