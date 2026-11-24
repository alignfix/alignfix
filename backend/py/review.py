# py/review.py
"""
Word-level review: how consistently each word is translated.

For every word w on one side (case-folded, punctuation skipped) and every
occurrence of w, the *variant* is what that occurrence is aligned to: the
aligned words of the other side, in sentence order ("the house"), or
"unaligned". Then

    consistency(w) = count of the most common variant / occurrences of w

(the unaligned bucket counts as a variant), and w is *suspicious* when it
occurs at least SUSPICIOUS_MIN_TOTAL times and

    consistency < LOW_CONSISTENCY, or
    it has MANY_VARIANTS or more aligned variants, or
    HIGH_UNALIGNED or more of its occurrences are unaligned.

The same occurrence statistics as lexicon.py, but with the raw variant counts
kept, so the review page can show them. Results are cached per project and
side until the sentences or the hide list change.

The phrase table (phrase_table) summarises the extracted phrase pairs per
source phrase, for export.
"""
import math
from collections import Counter, defaultdict

from db import get_db
from alignment import parse_alignment
from lexicon import normalize, is_content
import progress

SUSPICIOUS_MIN_TOTAL = 10
LOW_CONSISTENCY = 0.75
MANY_VARIANTS = 4
HIGH_UNALIGNED = 0.20
MAX_VARIANTS_KEPT = 50
UNALIGNED = ""            # variant key of unaligned occurrences

_cache = {}               # (project_id, side) -> (signature, words)


def _entropy(counts):
    total = sum(counts)
    if not total:
        return 0.0
    return max(0.0, -sum(c / total * math.log2(c / total) for c in counts if c))


def suspicion(total, consistency, num_variants, unaligned_share):
    """(reasons, score) for one word; no reasons = not suspicious."""
    reasons, score = [], 0
    if total < SUSPICIOUS_MIN_TOTAL:
        return reasons, score
    if consistency < LOW_CONSISTENCY:
        reasons.append("low consistency")
        score += 3
    if num_variants >= MANY_VARIANTS:
        reasons.append("many variants")
        score += 2
    if unaligned_share >= HIGH_UNALIGNED:
        reasons.append("often unaligned")
        score += 2
    return reasons, score


def _signature(cursor, project_id):
    """Changes whenever sentences, alignments or the hide list change."""
    cursor.execute(
        "SELECT COUNT(*), MAX(row_id), TOTAL(LENGTH(alignment)), TOTAL(LENGTH(line1) + LENGTH(line2)), "
        "MAX(updated_at) FROM alignments WHERE project_id=? AND deleted_at IS NULL", (project_id,))
    sig = cursor.fetchone()
    cursor.execute("SELECT COUNT(*), MAX(id) FROM ignored WHERE project_id=?", (project_id,))
    return sig + cursor.fetchone()


def _hidden_words(cursor, project_id, side):
    """Words hidden whatever their translation (hide-list wildcards) on `side`."""
    cursor.execute("SELECT src_phrase, tgt_phrase FROM ignored WHERE project_id=?", (project_id,))
    hidden = set()
    for src, tgt in cursor.fetchall():
        src, tgt = (src or "").strip(), (tgt or "").strip()
        word = src if side == "src" and src and not tgt else tgt if side == "tgt" and tgt and not src else None
        if word and " " not in word:
            hidden.add(word.casefold())
    return hidden


async def word_stats(project_id, side="src"):
    """
    {word: row} for all words of `side` ('src' or 'tgt'), see module docstring.
    Rows: word, total, consistency, top, num_variants, unaligned, unaligned_share,
    entropy, variants [[variant, count], ...] (most frequent first, '' = unaligned),
    suspicious, score, reasons, hidden.
    """
    if side not in ("src", "tgt"):
        raise ValueError("side must be 'src' or 'tgt'")
    _, cursor = get_db()
    sig = _signature(cursor, project_id)
    cached = _cache.get((project_id, side))
    if cached and cached[0] == sig:
        return cached[1]

    cursor.execute("SELECT line1, line2, alignment FROM alignments "
                   "WHERE project_id=? AND deleted_at IS NULL", (project_id,))
    rows = cursor.fetchall()
    variants = defaultdict(Counter)
    n = len(rows) or 1
    for i, (line1, line2, alignment) in enumerate(rows):
        if i % 2000 == 0:
            await progress.checkpoint(i / n, f"{i:,} / {len(rows):,} sentences")
        src = (line1 or "").split()
        tgt = (line2 or "").split()
        try:
            links = parse_alignment(alignment or "")
        except ValueError:
            links = []
        if side == "src":
            words, other = src, tgt
            partners = defaultdict(set)
            for s, t in links:
                if 0 <= s < len(src) and 0 <= t < len(tgt):
                    partners[s].add(t)
        else:
            words, other = tgt, src
            partners = defaultdict(set)
            for s, t in links:
                if 0 <= s < len(src) and 0 <= t < len(tgt):
                    partners[t].add(s)
        for pos, tok in enumerate(words):
            if not is_content(tok):
                continue
            aligned = [normalize(other[j]) for j in sorted(partners.get(pos, ())) if is_content(other[j])]
            variants[normalize(tok)][" ".join(aligned)] += 1

    hidden = _hidden_words(cursor, project_id, side)
    words = {}
    for word, counter in variants.items():
        total = sum(counter.values())
        unaligned = counter.get(UNALIGNED, 0)
        ranked = counter.most_common()
        top_variant, top_count = ranked[0]
        aligned_variants = len(counter) - (1 if unaligned else 0)
        consistency = top_count / total
        unaligned_share = unaligned / total
        reasons, score = suspicion(total, consistency, aligned_variants, unaligned_share)
        words[word] = {
            "word": word,
            "total": total,
            "consistency": consistency,
            "top": top_variant,
            "num_variants": aligned_variants,
            "unaligned": unaligned,
            "unaligned_share": unaligned_share,
            "entropy": _entropy(counter.values()),
            "variants": [[v, c] for v, c in ranked[:MAX_VARIANTS_KEPT]],
            "suspicious": bool(reasons),
            "score": score,
            "reasons": reasons,
            "hidden": word in hidden,
        }
    _cache[(project_id, side)] = (sig, words)
    return words


CONSISTENCY_BUCKETS = [("<50%", 0.0, 0.5), ("50–75%", 0.5, 0.75), ("75–90%", 0.75, 0.9),
                       ("90–99%", 0.9, 0.99), ("≥99%", 0.99, 1.01)]
FREQUENCY_BUCKETS = [("1–9", 1, 10), ("10–19", 10, 20), ("20–49", 20, 50), ("50–99", 50, 100),
                     ("100–999", 100, 1000), ("1000+", 1000, float("inf"))]


def _sort_key(mode):
    if mode == "consistency":    # worst first
        return lambda r: (r["consistency"], -r["total"], r["word"])
    if mode == "suspicious":
        return lambda r: (-r["suspicious"], -r["score"], r["consistency"], -r["total"], r["word"])
    if mode == "alpha":
        return lambda r: r["word"]
    return lambda r: (-r["total"], r["consistency"], r["word"])   # frequency


async def word_overview(project_id, side="src", start=0, length=25, search="",
                        sort="suspicious", suspicious_only=False, min_total=1,
                        include_hidden=False):
    """One page of the word table plus summary and charts of the whole project."""
    words = await word_stats(project_id, side)
    rows = [r for r in words.values() if include_hidden or not r["hidden"]]

    frequent = [r for r in rows if r["total"] >= SUSPICIOUS_MIN_TOTAL]
    summary = {
        "words": len(rows),
        "frequent": len(frequent),
        "suspicious": sum(r["suspicious"] for r in rows),
        "hidden": sum(r["hidden"] for r in words.values()),
        "occurrences": sum(r["total"] for r in rows),
        "unaligned": sum(r["unaligned"] for r in rows),
        # occurrence-weighted mean consistency of the frequent words
        "consistency": (sum(r["consistency"] * r["total"] for r in frequent) /
                        (sum(r["total"] for r in frequent) or 1)) if frequent else None,
        "reasons": dict(Counter(reason for r in rows for reason in r["reasons"])),
        "thresholds": {"min_total": SUSPICIOUS_MIN_TOTAL, "low_consistency": LOW_CONSISTENCY,
                       "many_variants": MANY_VARIANTS, "high_unaligned": HIGH_UNALIGNED},
    }
    charts = {
        "consistency": [[label, sum(lo <= r["consistency"] < hi for r in frequent),
                         sum(lo <= r["consistency"] < hi and r["suspicious"] for r in frequent)]
                        for label, lo, hi in CONSISTENCY_BUCKETS],
        "frequency": [[label, sum(lo <= r["total"] < hi for r in rows),
                       sum(lo <= r["total"] < hi and r["suspicious"] for r in rows)]
                      for label, lo, hi in FREQUENCY_BUCKETS],
    }

    filtered = [r for r in rows if r["total"] >= max(1, int(min_total or 1))]
    if suspicious_only:
        filtered = [r for r in filtered if r["suspicious"]]
    needle = (search or "").strip().casefold()
    if needle:
        filtered = [r for r in filtered
                    if needle in r["word"] or any(needle in v for v, _ in r["variants"][:10])]
    filtered.sort(key=_sort_key(sort))
    start, length = max(0, int(start or 0)), max(1, int(length or 25))
    return {
        "total": len(rows),
        "filtered": len(filtered),
        "rows": filtered[start:start + length],
        "summary": summary,
        "charts": charts,
    }


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
