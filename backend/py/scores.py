# py/scores.py
import sqlite3
import json

from db import get_db
from projects import get_alignment_row_ids
from statistics import median

from lexicon import Lexicon, normalize, is_content, consistency_anomalies, consistency_score


def write_scores(project_id, scores, row_ids=None):
    """
    Store one score per active alignment. scores[i] belongs to row_ids[i];
    if row_ids is omitted, scores are matched positionally to the active
    (non-deleted) rows ordered by row_id, i.e. the order of get_alignments().
    """
    conn, cursor = get_db()
    if row_ids is None:
        row_ids = get_alignment_row_ids(project_id)

    if len(scores) != len(row_ids):
        print(f"Warning: got {len(scores)} scores for {len(row_ids)} alignments; "
              f"only the first {min(len(scores), len(row_ids))} are stored.")

    cursor.executemany("""
        UPDATE alignments
        SET score = ?
        WHERE project_id = ? AND row_id = ?
    """, [(float(score), project_id, row_id) for row_id, score in zip(row_ids, scores)])
    conn.commit()


def import_scores_from_file(project_id, scores):
    try:
        write_scores(project_id, [round(float(score), 2) for score in scores])
        return True
    except (ValueError, TypeError, sqlite3.Error) as e:
        print("Error occurred while importing scores:", e)
    return False


def get_active_rows(project_id):
    """(row_id, line1, line2, alignment) of the active alignments, ordered by row_id."""
    _, cursor = get_db()
    cursor.execute("""
        SELECT row_id, line1, line2, alignment
        FROM alignments
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY row_id
    """, (project_id,))
    return cursor.fetchall()


def rank_normalize(values):
    """Map values to [0, 1] by rank (ties share their mean rank); robust to outliers."""
    n = len(values)
    if n == 0:
        return []
    if n == 1:
        return [0.5]
    order = sorted(range(n), key=lambda i: values[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[order[j + 1]] == values[order[i]]:
            j += 1
        mean_rank = (i + j) / 2
        for k in range(i, j + 1):
            ranks[order[k]] = mean_rank / (n - 1)
        i = j + 1
    return ranks


def assign_auto_scores(project_id):
    """
    Translation clarity: how predictable the translations of a sentence's words
    are, from the entropy H(O(w)) of each word's outcome distribution (aligned
    partners plus being left unaligned), estimated from the word alignments.
    Weighting by frequency means a word with one dominant translation and a few
    noisy variants still counts as clear. Sentence difficulty is the mean entropy
    over its content tokens on both sides; scores are rank-normalized and
    inverted, so 1 = clearest and 0 = most ambiguous.
    """
    try:
        rows = get_active_rows(project_id)
        lex = Lexicon.build((line1, line2, align) for _, line1, line2, align in rows)

        known = list(lex.src.entropy.values()) + list(lex.tgt.entropy.values())
        # Words too rare for reliable statistics get the median entropy.
        default = median(known) if known else 0.0

        print(f"Calculating translation clarity for {len(rows)} alignments "
              f"({len(lex.src.entropy)} source / {len(lex.tgt.entropy)} target words with statistics).")

        raw_scores = []
        for _, line1, line2, _ in rows:
            entropies = [lex.src.entropy.get(normalize(t), default) for t in line1.split() if is_content(t)]
            entropies += [lex.tgt.entropy.get(normalize(t), default) for t in line2.split() if is_content(t)]
            raw_scores.append(sum(entropies) / len(entropies) if entropies else default)

        scores = [round(1 - r, 5) for r in rank_normalize(raw_scores)]
        write_scores(project_id, scores, row_ids=[row[0] for row in rows])

        return True

    except sqlite3.Error as e:
        print("Error occurred while assigning automatic scores:", e)

    return False

# Lexicon of the last consistency run per project, reused to explain single rows.
_consistency_lexicons = {}


def assign_consistency_scores(project_id):
    """
    Alignment consistency: flags sentence pairs containing words that behave
    unlike they usually do in the corpus - left unaligned although they are
    usually aligned, or without any of their usual translations on the other
    side (possible omission, mistranslation or hallucinated addition).
    1 = consistent, lower = more suspicious; see lexicon.consistency_anomalies.
    """
    try:
        rows = get_active_rows(project_id)
        lex = Lexicon.build((line1, line2, align) for _, line1, line2, align in rows)
        _consistency_lexicons[project_id] = lex

        print(f"Calculating alignment consistency for {len(rows)} alignments.")

        scores = []
        flagged_rows = 0
        for _, line1, line2, align in rows:
            flagged = consistency_anomalies(lex, line1, line2, align)
            flagged_rows += bool(flagged)
            scores.append(round(consistency_score(flagged), 5))

        print(f"{flagged_rows} of {len(rows)} sentence pairs contain unexpected tokens.")
        write_scores(project_id, scores, row_ids=[row[0] for row in rows])
        return True

    except sqlite3.Error as e:
        print("Error occurred while assigning consistency scores:", e)

    return False


def explain_consistency(project_id, row_id, build=False):
    """
    Anomalous tokens of one row. Uses the lexicon of the last consistency run in
    this session; without one, returns None unless build=True (slow on large corpora).
    """
    lex = _consistency_lexicons.get(project_id)
    if lex is None:
        if not build:
            return None
        rows = get_active_rows(project_id)
        lex = Lexicon.build((line1, line2, align) for _, line1, line2, align in rows)
        _consistency_lexicons[project_id] = lex

    _, cursor = get_db()
    cursor.execute(
        "SELECT line1, line2, alignment FROM alignments WHERE project_id = ? AND row_id = ?",
        (project_id, row_id))
    row = cursor.fetchone()
    if not row:
        return []
    return consistency_anomalies(lex, *row)


def get_scores(project_id):
    conn, cursor = get_db()
    cursor.execute("""
        SELECT score
        FROM alignments
        WHERE project_id = ? AND deleted_at IS NULL AND score IS NOT NULL
    """, (project_id,))
    scores = cursor.fetchall()
    return scores

def bin_scores(scores, bin_count=20):
    if not scores:
        return []
    
    min_score = min(scores)
    max_score = max(scores)
    bin_size = (max_score - min_score) / bin_count

    bins = [0] * bin_count

    for score in scores:
        if score == max_score:
            bin_index = bin_count - 1
        else:
            bin_index = int((score - min_score) / bin_size)
        bins[bin_index] += 1

    binned_scores = [
        {
            "bin": min_score + i * bin_size, 
            "count": count
        } for i, count in enumerate(bins)
    ]

    return binned_scores

def save_scores(project_id, scores):
    # scores come from get_alignments() order (see backend/js/scores.js)
    write_scores(project_id, scores)
