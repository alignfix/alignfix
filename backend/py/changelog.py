# py/changelog.py
"""
The change log: what happened to each sentence pair, and why.

Every action that changes sentences (a fix, an augmentation, a deletion, an
edit by hand) opens a *batch* with a reason. Within a batch each sentence pair
gets one entry with its text before the first change and after the last, so a
fix that touches a pair twice is still one entry. The download turns the log
into a change report and tells where every exported line came from.

    with changelog.batch(project_id, "fix", 'Replaced "rot" with "crimson"'):
        changelog.record(row_id)             # before changing the row
        ...change the row...
    # on leaving the block the new texts are read back

Actions: 'edit' (text changed), 'delete', 'add' (origin_row: the copied pair).
"""
from contextlib import contextmanager

from db import get_db

_current = None   # the open batch: {"project_id", "batch", "action", "reason", "rows": {row_id: origin}}


def _next_batch(cursor, project_id):
    cursor.execute("SELECT COALESCE(MAX(batch), 0) + 1 FROM changes WHERE project_id=?", (project_id,))
    return cursor.fetchone()[0]


@contextmanager
def batch(project_id, action, reason):
    """Open a batch; nested batches join the outer one."""
    global _current
    if _current is not None:
        yield _current
        return
    _, cursor = get_db()
    _current = {"project_id": project_id, "batch": _next_batch(cursor, project_id),
                "action": action, "reason": reason, "rows": {}}
    try:
        yield _current
        _finish(_current)
    finally:
        _current = None


def set_reason(reason, action=None):
    """Change the reason (and action) for the entries recorded from now on."""
    if _current is not None:
        if reason == _current["reason"] and action in (None, _current["action"]):
            return
        if _current["rows"]:
            # entries already recorded keep their reason: start a new batch
            _finish(_current)
            _, cursor = get_db()
            _current["batch"] = _next_batch(cursor, _current["project_id"])
            _current["rows"] = {}
        _current["reason"] = reason
        if action:
            _current["action"] = action


def record(row_id, origin_row=None):
    """Note a sentence pair before it changes (or, for 'add', after it was inserted)."""
    if _current is None or row_id in _current["rows"]:
        return
    conn, cursor = get_db()
    b = _current
    if b["action"] == "add":
        old = (None, None)
    else:
        cursor.execute("SELECT line1, line2 FROM alignments WHERE project_id=? AND row_id=?",
                       (b["project_id"], row_id))
        old = cursor.fetchone() or (None, None)
    cursor.execute(
        "INSERT OR IGNORE INTO changes (project_id, batch, row_id, action, reason, origin_row, old_line1, old_line2) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (b["project_id"], b["batch"], row_id, b["action"], b["reason"], origin_row, old[0], old[1]))
    b["rows"][row_id] = origin_row


def _finish(b):
    """Read back the new texts; drop entries of pairs that did not change after all."""
    if not b["rows"]:
        return
    conn, cursor = get_db()
    pid, nr = b["project_id"], b["batch"]
    cursor.execute("""
        UPDATE changes SET
            new_line1 = (SELECT a.line1 FROM alignments a WHERE a.project_id = changes.project_id
                         AND a.row_id = changes.row_id AND a.deleted_at IS NULL),
            new_line2 = (SELECT a.line2 FROM alignments a WHERE a.project_id = changes.project_id
                         AND a.row_id = changes.row_id AND a.deleted_at IS NULL)
        WHERE project_id=? AND batch=?""", (pid, nr))
    cursor.execute("""
        DELETE FROM changes WHERE project_id=? AND batch=? AND action='edit'
        AND old_line1 IS new_line1 AND old_line2 IS new_line2""", (pid, nr))
    conn.commit()


def record_many(row_ids):
    """record() for many pairs at once (pairs about to be deleted, say)."""
    if _current is None:
        return
    conn, cursor = get_db()
    b = _current
    ids = [r for r in dict.fromkeys(row_ids) if r not in b["rows"]]
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        marks = ",".join("?" * len(chunk))
        cursor.execute(
            "INSERT OR IGNORE INTO changes (project_id, batch, row_id, action, reason, old_line1, old_line2) "
            f"SELECT project_id, ?, row_id, ?, ?, line1, line2 FROM alignments WHERE project_id=? AND row_id IN ({marks})",
            (b["batch"], b["action"], b["reason"], b["project_id"], *chunk))
    for r in ids:
        b["rows"][r] = None


def describe_fix(fix):
    """Reason text of a fix or augmentation (texts as the person typed them)."""
    src, tgt = (fix.get("src_phrase") or "").strip(), (fix.get("tgt_phrase") or "").strip()
    src_fix, tgt_fix = (fix.get("src_fix") or "").strip(), (fix.get("tgt_fix") or "").strip()
    parts = []
    if src_fix and src_fix != src:
        parts.append(f'source "{src}" → "{src_fix}"')
    if tgt_fix and tgt_fix != tgt:
        parts.append(f'target "{tgt}" → "{tgt_fix}"')
    what = ", ".join(parts) or f'"{src}" ↔ "{tgt}"'
    if fix.get("type") == "augment":
        return f"Augmentation: copy with {what}"
    return f"Find & fix: {what}"


def log_now(project_id, action, reason, row_ids, origin_rows=None):
    """Record finished changes of several pairs at once (e.g. a deletion), as one batch."""
    with batch(project_id, action, reason):
        for i, row_id in enumerate(row_ids):
            record(row_id, origin_rows[i] if origin_rows else None)


def get_changes(project_id):
    """All entries, oldest first: dicts with row_id, action, reason, origin_row, old/new texts, created_at."""
    _, cursor = get_db()
    cursor.execute("""
        SELECT batch, row_id, action, reason, origin_row, old_line1, old_line2, new_line1, new_line2, created_at
        FROM changes WHERE project_id=? ORDER BY batch, row_id""", (project_id,))
    keys = ("batch", "row_id", "action", "reason", "origin_row",
            "old_line1", "old_line2", "new_line1", "new_line2", "created_at")
    return [dict(zip(keys, r)) for r in cursor.fetchall()]


def origins(project_id):
    """{row_id: original row_id} for pairs added by augmentation (followed back to an original pair)."""
    _, cursor = get_db()
    cursor.execute("SELECT row_id, origin_row FROM changes WHERE project_id=? AND action='add' "
                   "AND origin_row IS NOT NULL", (project_id,))
    parent = dict(cursor.fetchall())
    out = {}
    for row_id in parent:
        seen, cur = set(), row_id
        while cur in parent and cur not in seen:
            seen.add(cur)
            cur = parent[cur]
        out[row_id] = cur
    return out
