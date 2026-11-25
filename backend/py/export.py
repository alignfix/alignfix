# py/export.py
"""
The curated corpus for download, with what is needed to reproduce it:

- where every exported line came from (its line in the uploaded files; for an
  augmented pair, the line of the pair it was copied from) and whether it was
  edited;
- the change log as a table, and a short report: how many pairs were deleted,
  edited and added, and why;
- optionally a train / dev / test split in which no source or target sentence
  occurs in two parts (pairs sharing a sentence always go to the same part).
"""
import random
import re
import unicodedata
from collections import Counter, defaultdict

from db import get_db
from text import detokenise
import changelog


def _key(text):
    """Comparison form of a sentence: case, spacing and punctuation ignored."""
    text = unicodedata.normalize("NFKC", text or "").casefold()
    text = re.sub(r"[^\w]+", " ", text)
    return " ".join(text.split())


class _Groups:
    """Union-find over row indexes."""

    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, i):
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.parent[b] = a


def split_rows(lines1, lines2, dev_size, test_size, seed=1):
    """
    ['train' | 'dev' | 'test'] per row. Rows sharing a source or a target
    sentence (compared by _key) form one group and go to the same part; groups
    are shuffled with the seed and fill test, then dev, then train.
    """
    n = len(lines1)
    groups = _Groups(n)
    first = {}
    for i in range(n):
        for side, text in (("s", lines1[i]), ("t", lines2[i])):
            key = (side, _key(text))
            if key[1] == "":
                continue
            if key in first:
                groups.union(first[key], i)
            else:
                first[key] = i
    members = defaultdict(list)
    for i in range(n):
        members[groups.find(i)].append(i)
    order = sorted(members)          # deterministic before shuffling
    random.Random(seed).shuffle(order)

    part = ["train"] * n
    want = {"test": max(0, int(test_size)), "dev": max(0, int(dev_size))}
    have = {"test": 0, "dev": 0}
    for root in order:
        rows = members[root]
        for name in ("test", "dev"):
            # a group goes into a part only if it fits; big groups end up in train
            if have[name] + len(rows) <= want[name]:
                for i in rows:
                    part[i] = name
                have[name] += len(rows)
                break
        if have["test"] >= want["test"] and have["dev"] >= want["dev"]:
            break
    return part


def corpus_export(project_id, dev_size=0, test_size=0, seed=1):
    """Everything for the download zip (texts detokenised; line numbers 1-based)."""
    _, cursor = get_db()
    cursor.execute("SELECT name, created_at FROM projects WHERE id=?", (project_id,))
    name, created_at = cursor.fetchone() or ("", "")
    cursor.execute("SELECT row_id, line1, line2, alignment FROM alignments "
                   "WHERE project_id=? AND deleted_at IS NULL ORDER BY row_id", (project_id,))
    rows = cursor.fetchall()

    changes = changelog.get_changes(project_id)
    origin = changelog.origins(project_id)
    added = {c["row_id"] for c in changes if c["action"] == "add"}
    edited = {c["row_id"] for c in changes if c["action"] == "edit"}

    cursor.execute("SELECT COUNT(*) FROM alignments WHERE project_id=?", (project_id,))
    total_rows = cursor.fetchone()[0]
    imported = total_rows - len(added)

    def original_line(row_id):
        return origin.get(row_id, row_id) + 1

    lines1 = [detokenise(r[1]) for r in rows]
    lines2 = [detokenise(r[2]) for r in rows]
    provenance = []
    for out_i, r in enumerate(rows):
        row_id = r[0]
        if row_id in added:
            status = "added, edited" if row_id in edited else "added"
        else:
            status = "edited" if row_id in edited else "original"
        provenance.append({"line": out_i + 1, "original_line": original_line(row_id), "status": status})

    change_rows = [{
        "step": c["batch"],
        "date": c["created_at"],
        "action": c["action"],
        "reason": c["reason"],
        "original_line": original_line(c["row_id"]),
        "copied_from": (c["origin_row"] + 1) if c["origin_row"] is not None else None,
        "old_source": detokenise(c["old_line1"]) if c["old_line1"] is not None else "",
        "old_target": detokenise(c["old_line2"]) if c["old_line2"] is not None else "",
        "new_source": detokenise(c["new_line1"]) if c["new_line1"] is not None else "",
        "new_target": detokenise(c["new_line2"]) if c["new_line2"] is not None else "",
    } for c in changes]

    by_reason = defaultdict(Counter)
    for c in changes:
        by_reason[c["action"]][c["reason"]] += 1
    cursor.execute("SELECT COUNT(*) FROM review_marks WHERE project_id=? AND status='ok'", (project_id,))
    marked_ok = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM review_ok_words WHERE project_id=?", (project_id,))
    ok_words = cursor.fetchone()[0]

    deleted_rows = {c["row_id"] for c in changes if c["action"] == "delete"}
    summary = {
        "project": name,
        "created_at": created_at,
        "imported_pairs": imported,
        "deleted_pairs": len(deleted_rows),
        "edited_pairs": len(edited),
        "added_pairs": len(added),
        "exported_pairs": len(rows),
        "review_marked_ok_pairs": marked_ok,
        "review_marked_ok_words": ok_words,
        "reasons": {action: dict(counter.most_common()) for action, counter in by_reason.items()},
    }

    result = {
        "summary": summary,
        "lines1": lines1,
        "lines2": lines2,
        "alignments": [r[3] or "" for r in rows],
        "provenance": provenance,
        "changes": change_rows,
        "split": None,
    }
    if dev_size or test_size:
        part = split_rows(lines1, lines2, dev_size, test_size, seed)
        result["split"] = part
        summary["split"] = {"seed": seed, **Counter(part)}
    return result
