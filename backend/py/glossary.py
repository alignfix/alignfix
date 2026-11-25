# py/glossary.py
"""
The glossary: translation pairs a person checked and confirmed.

Entries come from the Phrases page (a phrase pair marked OK), from Review >
Words (a word with the translations confirmed for it) or from a file. A
confirmed phrase pair leaves the list of phrase pairs to check (phrases.ignore
= IN_GLOSSARY, see phrases.apply_ignore_rules). Review uses the glossary
twice: a confirmed translation counts as a usual translation, and a pair whose
source has a glossary term without any of its confirmed translations on the
target side (or the other way round) is flagged.

Texts are stored tokenised, like the phrases; comparisons ignore case.
"""
import json

from db import get_db
from text import tokenise, detokenise


def _clean(tok_str):
    return " ".join((tok_str or "").split())


def fold(tok_str):
    return _clean(tok_str).casefold()


def add_entries(project_id, pairs, origin="manual"):
    """pairs: (tokenised src, tokenised tgt). Returns the number of new entries."""
    conn, cursor = get_db()
    rows = [(project_id, _clean(s), _clean(t), origin) for s, t in pairs if _clean(s) and _clean(t)]
    before = conn.total_changes
    cursor.executemany("INSERT OR IGNORE INTO glossary (project_id, src, tgt, origin) VALUES (?, ?, ?, ?)", rows)
    added = conn.total_changes - before
    conn.commit()
    _refresh_phrases(project_id)
    return added


def add_text_pairs(project_id, pairs, origin="manual"):
    """Like add_entries, for pairs as typed (not tokenised)."""
    return add_entries(project_id, [(tokenise(s, as_string=True), tokenise(t, as_string=True))
                                    for s, t in pairs if (s or "").strip() and (t or "").strip()], origin)


def add_phrase_pair(project_id, phrase_id):
    """Confirm a phrase pair of the phrase table. Returns 1 if it was new."""
    _, cursor = get_db()
    cursor.execute("SELECT src_phrase, tgt_phrase FROM phrases WHERE id=? AND project_id=?", (phrase_id, project_id))
    row = cursor.fetchone()
    if not row:
        return 0
    return add_entries(project_id, [row], origin="phrases")


def remove_entry(project_id, entry_id):
    conn, cursor = get_db()
    cursor.execute("DELETE FROM glossary WHERE id=? AND project_id=?", (entry_id, project_id))
    conn.commit()
    _refresh_phrases(project_id)


def remove_term(project_id, side, term):
    """Remove every entry with this term (as Review shows it: folded) on the given side."""
    conn, cursor = get_db()
    col = "tgt" if side == "tgt" else "src"
    cursor.execute(f"SELECT id, {col} FROM glossary WHERE project_id=?", (project_id,))
    ids = [(i,) for i, text in cursor.fetchall() if fold(text) == fold(term)]
    cursor.executemany("DELETE FROM glossary WHERE id=?", ids)
    conn.commit()
    _refresh_phrases(project_id)
    return len(ids)


def clear(project_id):
    conn, cursor = get_db()
    cursor.execute("DELETE FROM glossary WHERE project_id=?", (project_id,))
    conn.commit()
    _refresh_phrases(project_id)


def _refresh_phrases(project_id):
    from phrases import apply_ignore_rules
    apply_ignore_rules(project_id)


def folded_pairs(project_id):
    """{(folded src, folded tgt)} of all entries."""
    _, cursor = get_db()
    cursor.execute("SELECT src, tgt FROM glossary WHERE project_id=?", (project_id,))
    return {(fold(s), fold(t)) for s, t in cursor.fetchall()}


def fetch(project_id, start=0, length=10, search=""):
    """One page of entries, newest first: (rows, total, filtered)."""
    _, cursor = get_db()
    cursor.execute("SELECT id, src, tgt, origin, created_at FROM glossary WHERE project_id=? ORDER BY id DESC",
                   (project_id,))
    rows = cursor.fetchall()
    total = len(rows)
    needle = (search or "").strip().casefold()
    if needle:
        rows = [r for r in rows if needle in detokenise(r[1]).casefold() or needle in detokenise(r[2]).casefold()]
    page = rows[max(0, int(start)):max(0, int(start)) + max(1, int(length))]
    return ([{"id": r[0], "src": detokenise(r[1]), "tgt": detokenise(r[2]), "origin": r[3], "created_at": r[4]}
             for r in page], total, len(rows))


def count(project_id):
    _, cursor = get_db()
    cursor.execute("SELECT COUNT(*) FROM glossary WHERE project_id=?", (project_id,))
    return cursor.fetchone()[0]


def export_entries(project_id):
    """[{src, tgt}] as text (detokenised), oldest first."""
    _, cursor = get_db()
    cursor.execute("SELECT src, tgt FROM glossary WHERE project_id=? ORDER BY id", (project_id,))
    return [{"src": detokenise(s), "tgt": detokenise(t)} for s, t in cursor.fetchall()]


def parse_file(content):
    """
    Glossary file: a JSON list of {"src", "tgt"}, or text with one "source<TAB>target"
    pair per line (a header line "src<TAB>tgt" is skipped; '#' starts a comment).
    Returns [(src, tgt)] as text; raises ValueError for anything else.
    """
    text = (content or "").lstrip("﻿").strip()
    if not text:
        raise ValueError("The file contains no entries.")
    if text[0] in "[{":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise ValueError(f"The file is not valid JSON (line {e.lineno}: {e.msg}).")
        if not isinstance(data, list):
            raise ValueError('Expected a JSON list like [{"src": "...", "tgt": "..."}].')
        pairs = []
        for i, entry in enumerate(data, 1):
            if not isinstance(entry, dict) or not str(entry.get("src", "")).strip() or not str(entry.get("tgt", "")).strip():
                raise ValueError(f"Entry {i} is not an object with src and tgt.")
            pairs.append((str(entry["src"]).strip(), str(entry["tgt"]).strip()))
        return pairs
    pairs = []
    for n, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("\t")]
        if len(parts) < 2 or not parts[0] or not parts[1]:
            raise ValueError(f"Line {n} is not a pair: write source<TAB>target.")
        if n == 1 and parts[0].lower() in ("src", "source") and parts[1].lower() in ("tgt", "target"):
            continue
        pairs.append((parts[0], parts[1]))
    if not pairs:
        raise ValueError("The file contains no entries.")
    return pairs


def import_file(project_id, content):
    """(entries read, entries added)."""
    pairs = parse_file(content)
    return len(pairs), add_text_pairs(project_id, pairs, origin="import")


def terms(project_id):
    """
    For checking sentences: {'src': {folded src term: {folded tgt terms}},
    'tgt': {folded tgt term: {folded src terms}}}; terms as tuples of tokens.
    """
    _, cursor = get_db()
    cursor.execute("SELECT src, tgt FROM glossary WHERE project_id=?", (project_id,))
    out = {"src": {}, "tgt": {}}
    for s, t in cursor.fetchall():
        s, t = tuple(fold(s).split()), tuple(fold(t).split())
        if s and t:
            out["src"].setdefault(s, set()).add(t)
            out["tgt"].setdefault(t, set()).add(s)
    return out
