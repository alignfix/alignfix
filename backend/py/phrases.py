from text import tokenise, detokenise, strip_nb_bl
from alignment import parse_alignment
from db import get_db

from collections import defaultdict
from itertools import islice

import sqlite3
import json
import string
import time

PHRASE_EXTRACTION_CHUNK_SIZE = 25_000
MAX_OCCURRENCES_PER_CHUNK = 300
MAX_NUM_PHRASES = 100_000

def chunked(iterable, size):
    it = iter(iterable)
    while True:
        chunk = list(islice(it, size))
        if not chunk:
            break
        yield chunk

def get_directed_phrases_from_texts_and_alignment(
    src_tokens, tgt_tokens, alignment_pairs, min_phrase_len=1, max_phrase_len=3, ignore_pairs=set()
):
    src_to_tgt = defaultdict(list)
    tgt_to_src = defaultdict(list)

    for s, t in alignment_pairs:
        src_to_tgt[s].append(t)
        tgt_to_src[t].append(s)

    def get_phrases(src_tokens, tgt_tokens, src_tgt_align_map, tgt_src_align_map, length, direction=1):

      len_src_tokens = len(src_tokens)
      phrases = []
      
      for start_src in range(len_src_tokens - length + 1):

        current_direction = direction

        end_src = start_src + length
        src_indices = range(start_src, end_src)

        aligned_tgts = []
        for i in src_indices:
            aligned_tgts.extend(src_tgt_align_map.get(i, []))

        if not aligned_tgts:
            continue

        start_tgt = min(aligned_tgts)
        end_tgt = max(aligned_tgts) + 1
        
        aligned_srcs = []
        for i in range(start_tgt, end_tgt):
            aligned_srcs.extend(tgt_src_align_map.get(i, []))

        aligned_start_src = min(aligned_srcs) if aligned_srcs else None
        aligned_end_src = max(aligned_srcs) + 1 if aligned_srcs else None

        if aligned_start_src == start_src and aligned_end_src == end_src:
            current_direction = 0

        src_phrase_tok = strip_nb_bl(src_tokens[start_src : end_src])
        tgt_phrase_tok = strip_nb_bl(tgt_tokens[start_tgt : end_tgt])

        src_phrase_strip = " ".join(src_phrase_tok)
        tgt_phrase_strip = " ".join(tgt_phrase_tok)

        if detokenise(src_phrase_strip.strip(string.punctuation)) and detokenise(tgt_phrase_strip.strip(
            string.punctuation
        )):
            

            if (src_phrase_strip, tgt_phrase_strip) in ignore_pairs:
                continue

            if direction == -1:
            
                phrases.append(
                    (tgt_phrase_strip, src_phrase_strip, current_direction, start_tgt, start_src)
                )
            
            else:
            
                phrases.append(
                    (src_phrase_strip, tgt_phrase_strip, current_direction, start_src, start_tgt)
                )

      return phrases

    phrases = []

    for length in range(min_phrase_len, max_phrase_len + 1):
        
        src_tgt_phrases = get_phrases(src_tokens, tgt_tokens, src_to_tgt, tgt_to_src, length, direction=1)
        for _tuple in src_tgt_phrases:
            phrases.append(_tuple)

        tgt_src_phrases = get_phrases(tgt_tokens, src_tokens, tgt_to_src, src_to_tgt, length, direction=-1)
        for _tuple in tgt_src_phrases:
            if _tuple[2] == 0:
                continue
            phrases.append(_tuple)

    return phrases

def process_line_pair(
    src_line,
    tgt_line,
    align_line,
    min_len=1,
    max_len=5,
    ignore_pairs=set()
):
    src_tokens = src_line.strip().split()
    tgt_tokens = tgt_line.strip().split()
    alignments = parse_alignment(align_line)

    return get_directed_phrases_from_texts_and_alignment(
        src_tokens,
        tgt_tokens,
        alignments,
        min_phrase_len=min_len,
        max_phrase_len=max_len,
        ignore_pairs=ignore_pairs
    )

def process_chunk(
    src_lines,
    tgt_lines,
    align_lines,
    min_len=1,
    max_len=5,
    chunk_offset=0,
    chunk_scores=[],
    threshold=1,
    ignore_pairs=set()
):
    phrase_pairs = []    

    for chunk_index, (src_line, tgt_line, align_line) in enumerate(zip(src_lines, tgt_lines, align_lines)):
        if chunk_scores and chunk_scores[chunk_index] < threshold:
            chunk_phrases = process_line_pair(src_line, tgt_line, align_line, min_len=min_len, max_len=max_len)
            for (src, tgt, _, _, _) in chunk_phrases:
                ignore_pairs.add((src, tgt))


    for chunk_index, (src_line, tgt_line, align_line) in enumerate(zip(src_lines, tgt_lines, align_lines)):
        if chunk_scores and chunk_scores[chunk_index] >= threshold:
            chunk_phrases = process_line_pair(src_line, tgt_line, align_line, min_len=min_len, max_len=max_len, ignore_pairs=ignore_pairs)
            row_index = chunk_index + chunk_offset
            for (src, tgt, direction, start, tgt_min) in chunk_phrases:
                phrase_pairs.append((row_index, src, tgt, direction, start, tgt_min))

    return phrase_pairs, ignore_pairs

def extract_phrases(src_lines, tgt_lines, align_lines, scores,
                    min_phrase_len=1, 
                    max_phrase_len=5, 
                    file_offset=0, 
                    min_count=2, 
                    max_count=MAX_OCCURRENCES_PER_CHUNK, 
                    threshold=1,
                    all_ignore_pairs=set()):
    
    if not scores:
        scores = [1] * len(src_lines)

    max_phrase_len = max(min_phrase_len, max_phrase_len)

    # total_chunks = (len(src_lines) + PHRASE_EXTRACTION_CHUNK_SIZE - 1) // PHRASE_EXTRACTION_CHUNK_SIZE
    count_below_count = 0
    count_above_count = 0
    count_filtered = 0

    start_time = time.time()

    phrase_count = defaultdict(set)
    for index, chunk_src_lines in enumerate(chunked(src_lines, PHRASE_EXTRACTION_CHUNK_SIZE)):

        print(f"Processing chunk {index + 1}...")

        chunk_offset = index * PHRASE_EXTRACTION_CHUNK_SIZE

        chunk_scores = scores[chunk_offset:chunk_offset + PHRASE_EXTRACTION_CHUNK_SIZE]
        chunk_tgt_lines = tgt_lines[chunk_offset:chunk_offset + PHRASE_EXTRACTION_CHUNK_SIZE]
        chunk_align_lines = align_lines[chunk_offset:chunk_offset + PHRASE_EXTRACTION_CHUNK_SIZE]

        phrases, ignore_pairs = process_chunk(
            chunk_src_lines,
            chunk_tgt_lines,
            chunk_align_lines,
            min_len=min_phrase_len,
            max_len=max_phrase_len,
            chunk_offset=chunk_offset,
            chunk_scores=chunk_scores,
            threshold=threshold,
            ignore_pairs=all_ignore_pairs
        )

        all_ignore_pairs.update(ignore_pairs)

        for (row_id, src_phrase, tgt_phrase, direction, _, _) in phrases:
            row_id = row_id + file_offset
            phrase_count[(src_phrase, tgt_phrase, direction)].add(row_id)

        # for phrase, row_ids in local_phrase_count.items():

        #     num_alignments = len(row_ids)

        #     if num_alignments > max_count:
        #         count_above_count += 1
        #     elif num_alignments >= min_count:
        #         phrase_count[phrase].extend(row_ids)
        #     else:
        #         count_below_count += 1

        count_filtered = len(phrase_count.keys())
        
        if count_filtered > MAX_NUM_PHRASES:
            phrase_count = defaultdict(
                list,
                dict(sorted(phrase_count.items(), key=lambda x: len(x[1]), reverse=True)[:MAX_NUM_PHRASES])
            )

    chunked_phrase_count = []

    sorted_phrase_count = sorted(
        phrase_count.items(), key=lambda x: len(x[1]), reverse=True
    )

    count_taken = 0
    
    for i, (phrase, occurrences_set) in enumerate(sorted_phrase_count):

        occurrences = list(occurrences_set)

        if len(occurrences) > max_count:
            count_above_count += 1
            continue
        elif len(occurrences) < min_count:
            break
        
        chunked_phrase_count.append({
            "phrase1": phrase[0],
            "phrase2": phrase[1],
            "chunk": phrase[3],
            "direction": phrase[2],
            "num_occurrences": len(occurrences),
            "occurrences": occurrences
        })
        count_taken += 1

    # count scores above threshold
    scores_above_threshold = sum(1 for score in scores if score >= threshold)
    scores_below_threshold = sum(1 for score in scores if score < threshold)

    stats = {
        "count_taken": count_taken,
        "count_filtered": count_filtered,
        "count_below": count_below_count,
        "count_above": count_above_count,
        "scores_below_threshold": scores_below_threshold,
        "scores_above_threshold": scores_above_threshold,
        "duration": int(time.time() - start_time)
    }

    return sorted(chunked_phrase_count, key=lambda x: len(x['occurrences']), reverse=True), stats

def delete_phrases(project_id):
    conn, cursor = get_db()

    cursor.execute('DELETE FROM occurrences WHERE project_id=?', (project_id,))
    cursor.execute('DELETE FROM phrases WHERE project_id=?', (project_id,))
    conn.commit()

def save_phrases(project_id, phrases,
                 phrase_chunk_size=10000,
                 occ_chunk_size=100000,
                 busy_timeout_ms=5000):
    """
    Bulk load phrases + occurrences for project_id into SQLite, in a way that
    is more concurrency-friendly (multiple writers/readers).
    
    Parameters:
      constructor: a callable that returns a new sqlite3.Connection
      project_id: int
      phrases: list of dicts with keys src_phrase, tgt_phrase, direction,
               num_occurrences, occurrences (iterable of row_ids)
      phrase_chunk_size: number of phrases to insert per batch
      occ_chunk_size: number of occurrence tuples to insert per batch
      busy_timeout_ms: how long to wait for locked database before failing
    """
    conn, cursor = get_db()
    conn.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")

    # Prepare the statement once
    insert_occ_sql = '''
      INSERT OR IGNORE INTO occurrences (row_id, id_phrases, project_id)
      VALUES (?, ?, ?)
    '''

    # Function to process a chunk of phrases
    def process_phrase_chunk(chunk):
        # Insert phrases one-by-one inside the transaction so we can reliably obtain each phrase id.
        # This avoids using cursor.lastrowid after executemany (which can be unreliable and produce negative start ids).
        for p in chunk:
            src = p.get('src_phrase', '')
            tgt = p.get('tgt_phrase', '')
            direction = int(p.get('direction', 0))
            real_num_occ = 0
            # Use INSERT OR REPLACE to ensure a single row per (project_id, src, tgt, direction).
            # executor.execute will set lastrowid for each insert.
            cursor.execute(
                "INSERT OR REPLACE INTO phrases (src_phrase, tgt_phrase, direction, project_id) VALUES (?, ?, ?, ?)",
                (src, tgt, direction, project_id)
            )
            pid = cursor.lastrowid
            if not pid:
                # Fallback: try to lookup the id (should be rare)
                cursor.execute(
                    "SELECT id FROM phrases WHERE src_phrase=? AND tgt_phrase=? AND direction=? AND project_id=?",
                    (src, tgt, direction, project_id)
                )
                row = cursor.fetchone()
                pid = row[0] if row else None

            # Prepare occurrences (deduplicate with set)
            if pid:
                occ_set = set(p.get('occurrences', []))
                occ_data = []
                for row_id in occ_set:
                    occ_data.append((int(row_id), pid, project_id))

                    # flush occurrences in chunks to keep memory low
                    if len(occ_data) >= occ_chunk_size:
                        cursor.executemany(insert_occ_sql, occ_data)
                        occ_data = []

                # final flush of remaining occurrences
                if occ_data:
                    cursor.executemany(insert_occ_sql, occ_data)
                
                # update phrases and set num_occurrences to actual inserted count
                real_num_occ = len(occ_set)
                cursor.execute(
                    "UPDATE phrases SET num_occurrences=? WHERE id=? AND project_id=?",
                    (real_num_occ, pid, project_id)
                )

    # Break phrases into chunks and do each in its own transaction
    for i in range(0, len(phrases), phrase_chunk_size):
        chunk = phrases[i : i + phrase_chunk_size]

        try:
            cursor.execute("BEGIN IMMEDIATE;")
            process_phrase_chunk(chunk)
            conn.commit()
        except sqlite3.OperationalError as e:
            conn.rollback()
            if "database is locked" in str(e).lower():
                # simple retry logic
                time.sleep(0.1)
                return save_phrases(project_id, chunk) 
            else:
                raise
                 

# ---------------------------------------------------------------- hide list
#
# phrases.ignore: 0 = shown, 1 = hidden by the user (that pair only),
# 2 = hidden by an entry of the hide list (table `ignored`). Hide-list entries
# are tokenised and compared case-insensitively:
#   src + tgt      hides that pair
#   src, tgt = ''  hides the source phrase whatever its translation (wildcard)
#   src = '', tgt  hides the target phrase whatever its source (wildcard)
# and a multi-word phrase is hidden when each of its words is hidden by a
# single-word wildcard on that side ("der die" if "der" and "die" are hidden).
# ignore=2 is recomputed by apply_ignore_rules() whenever the list or the
# phrases change, so removing an entry shows its phrases again.
# 3 = confirmed: the pair is in the glossary (glossary.py), recomputed the same way.

HIDDEN_BY_USER = 1
IN_GLOSSARY = 3
HIDDEN_BY_LIST = 2


def _fold(tok_str):
    return " ".join((tok_str or "").split()).casefold()


def add_phrases_to_ignore(project_id, phrases):
    """phrases: dicts with tokenised src_phrase / tgt_phrase (either may be '').
    Returns the number of new entries (duplicates are skipped)."""
    conn, cursor = get_db()
    rows = []
    for phrase in phrases:
        src = " ".join((phrase.get('src_phrase') or "").split())
        tgt = " ".join((phrase.get('tgt_phrase') or "").split())
        if src or tgt:
            rows.append((src, tgt, project_id))
    before = conn.total_changes
    cursor.executemany(
        'INSERT OR IGNORE INTO ignored (src_phrase, tgt_phrase, project_id) VALUES (?, ?, ?)', rows)
    added = conn.total_changes - before
    conn.commit()
    apply_ignore_rules(project_id)
    return added


def ignore_phrase_pair(project_id, src_phrase, tgt_phrase=""):
    """Add one (untokenised) entry to the hide list; tgt '' hides src everywhere."""
    return add_phrases_to_ignore(project_id, [{
        "src_phrase": tokenise(src_phrase, as_string=True) if src_phrase else "",
        "tgt_phrase": tokenise(tgt_phrase, as_string=True) if tgt_phrase else "",
    }])


def remove_phrase_to_ignore(project_id, phrase_id):
    conn, cursor = get_db()
    cursor.execute('DELETE FROM ignored WHERE id=? AND project_id=?', (phrase_id, project_id))
    conn.commit()
    apply_ignore_rules(project_id)


def apply_ignore_rules(project_id):
    """Set phrases.ignore=2 for exactly the phrases the hide list matches.
    Returns the number of phrases hidden by the list."""
    conn, cursor = get_db()
    cursor.execute('SELECT src_phrase, tgt_phrase FROM ignored WHERE project_id=?', (project_id,))
    pairs, any_src, any_tgt = set(), set(), set()
    for src, tgt in cursor.fetchall():
        s, t = _fold(src), _fold(tgt)
        if s and t:
            pairs.add((s, t))
        elif s:
            any_src.add(s)
        elif t:
            any_tgt.add(t)
    from glossary import folded_pairs
    confirmed = folded_pairs(project_id)
    words_src = {w for w in any_src if " " not in w}
    words_tgt = {w for w in any_tgt if " " not in w}

    def hidden(s, t):
        if (s, t) in pairs or s in any_src or t in any_tgt:
            return True
        ws, wt = s.split(), t.split()
        return (len(ws) > 1 and all(w in words_src for w in ws)) or \
               (len(wt) > 1 and all(w in words_tgt for w in wt))

    cursor.execute('SELECT id, src_phrase, tgt_phrase, ignore FROM phrases '
                   f'WHERE project_id=? AND ignore IN (0, {HIDDEN_BY_LIST}, {IN_GLOSSARY})', (project_id,))
    updates = defaultdict(list)
    for pid, src, tgt, flag in cursor.fetchall():
        s, t = _fold(src), _fold(tgt)
        if (s, t) in confirmed:
            want = IN_GLOSSARY
        elif (pairs or any_src or any_tgt) and hidden(s, t):
            want = HIDDEN_BY_LIST
        else:
            want = 0
        if want != flag:
            updates[want].append((pid,))
    for want, ids in updates.items():
        cursor.executemany(f'UPDATE phrases SET ignore={want} WHERE id=?', ids)
    conn.commit()
    cursor.execute('SELECT COUNT(*) FROM phrases WHERE project_id=? AND ignore=?',
                   (project_id, HIDDEN_BY_LIST))
    return cursor.fetchone()[0]
    

def get_phrases_to_ignore(project_id):
    _, cursor = get_db()
    cursor.execute('SELECT id, src_phrase, tgt_phrase FROM ignored WHERE project_id=? ORDER BY id', (project_id,))
    rows = cursor.fetchall()

    return rows

def delete_all_ignored_phrases(project_id):
    conn, cursor = get_db()

    cursor.execute('DELETE FROM ignored WHERE project_id=?', (project_id,))
    conn.commit()
    apply_ignore_rules(project_id)


def get_all_phrases_to_ignore(project_id):
    imported_phrase = get_phrases_to_ignore(project_id)
    rows = set()
    for (id, src, tgt) in imported_phrase:
        if src and tgt:   # wildcards are applied after extraction (apply_ignore_rules)
            rows.add((src, tgt))

    _, cursor = get_db()

    ignore = 0  # only fetch non-ignored phrases
    # 1) Count total rows for this project (before LIMIT/OFFSET)
    cursor.execute("SELECT src_phrase, tgt_phrase FROM phrases WHERE project_id=? AND ignore=1", (project_id,))
    res = cursor.fetchall()
    for (src, tgt) in res:
       rows.add((src, tgt))

    return rows

def set_ignore_phrase(project_id, phrase_id, ignore=1):
    conn, cursor = get_db()

    cursor.execute("""
        UPDATE phrases
        SET ignore = ?
        WHERE id = ? AND project_id = ?
    """, (ignore, phrase_id, project_id))

    conn.commit()

def get_phrase_id(project_id, phrase1_tok_str, phrase2_tok_str, direction):
    
    _, cursor = get_db()

    cursor.execute('SELECT id FROM phrases WHERE src_phrase=? AND tgt_phrase=? AND direction=? AND project_id=?',
                (phrase1_tok_str, phrase2_tok_str, direction, project_id))
    row = cursor.fetchone()

    if row:
        return row[0]
    
    return None

def get_phrase_occurrences(project_id, phrase1_tok_str, phrase2_tok_str, direction, limit=1000, offset=0):

    _, cursor = get_db()

    phrase_id = get_phrase_id(project_id, phrase1_tok_str, phrase2_tok_str, direction)
    if not phrase_id:
        return [], 0

    # get total count without limit/offset
    cursor.execute('''
        SELECT COUNT(*) 
        FROM occurrences o
        INNER JOIN alignments a ON o.row_id = a.row_id AND o.project_id = a.project_id
        WHERE o.id_phrases=? AND o.project_id=? AND a.deleted_at IS NULL
    ''', (phrase_id, project_id))
    total_count = cursor.fetchone()[0]

    # fetch paginated rows
    cursor.execute('''
        SELECT o.row_id 
        FROM occurrences o
        INNER JOIN alignments a ON o.row_id = a.row_id AND o.project_id = a.project_id
        WHERE o.id_phrases=? AND o.project_id=? AND a.deleted_at IS NULL
        LIMIT ? OFFSET ?
    ''', (phrase_id, project_id, limit, offset))
    rows = cursor.fetchall()

    return [row[0] for row in rows], total_count

def fetch_phrases(project_id, start, length, search_value, direction=0, min_length=1):
    """
    One page of the phrase table (most frequent first). min_length is accepted
    for compatibility; the extraction already applied the length limits.
    """
    _, cursor = get_db()

    ignore = 0  # only fetch non-ignored phrases
    base = "FROM phrases WHERE project_id=? AND ignore=? AND direction=? AND num_occurrences > 0"
    params = [project_id, ignore, direction]

    # Total rows (the count must use the same conditions as the page query, or
    # the table shows wrong totals and stops paging early)
    cursor.execute(f"SELECT COUNT(*) {base}", params)
    total_records = cursor.fetchone()[0]

    if search_value:
        search_value_tok_str = tokenise(search_value, as_string=True)
        like = f"%{search_value_tok_str}%"
        base += " AND (src_phrase LIKE ? OR tgt_phrase LIKE ?)"
        params += [like, like]
        cursor.execute(f"SELECT COUNT(*) {base}", params)
        filtered_records = cursor.fetchone()[0]
    else:
        filtered_records = total_records

    cursor.execute(
        f"SELECT id, src_phrase, tgt_phrase, direction, num_occurrences {base} "
        "ORDER BY num_occurrences DESC, id LIMIT ? OFFSET ?",
        params + [length, start],
    )
    phrases = cursor.fetchall()

    phrase_ids = [row[0] for row in phrases]
    src_phrases = [detokenise(row[1]) for row in phrases]
    tgt_phrases = [detokenise(row[2]) for row in phrases]
    directions = [row[3] for row in phrases]
    num_occurrences = [row[4] for row in phrases]

    return phrase_ids, src_phrases, tgt_phrases, directions, num_occurrences, total_records, filtered_records

def fetch_ignored_phrases(project_id, start, length):
    _, cursor = get_db()

    # Collect all ignored phrases from both sources
    all_phrases = []

    # 1) Get phrases hidden one by one (not those hidden by the list)
    cursor.execute("""SELECT id, src_phrase, tgt_phrase, 0 as imported
                      FROM phrases
                      WHERE project_id=? AND ignore=1
                      ORDER BY num_occurrences DESC""", (project_id,))
    phrases_ignored = cursor.fetchall()
    all_phrases.extend(phrases_ignored)

    # 2) Then the entries of the hide list (newest first)
    additional_phrases = get_phrases_to_ignore(project_id)
    for (id, src, tgt) in reversed(additional_phrases):
        all_phrases.append((id, src, tgt, 1))  # 1 = imported
    
    # 3) Calculate total count
    total_records = len(all_phrases)

    # 4) Apply pagination
    paginated_phrases = all_phrases[start:start + length]

    # 5) Build result arrays
    phrase_ids = []
    src_phrases = []
    tgt_phrases = []
    imported = []

    for row in paginated_phrases:
        phrase_ids.append(row[0])
        src_phrases.append(detokenise(row[1]))
        tgt_phrases.append(detokenise(row[2]))
        imported.append(row[3])

    return phrase_ids, src_phrases, tgt_phrases, imported, total_records


def export_ignore_list(project_id):
    """The hide list and the pairs hidden one by one, as {src, tgt} (untokenised;
    '' = any), in the format import_ignored_from_file reads."""
    _, cursor = get_db()
    seen, out = set(), []
    cursor.execute('SELECT src_phrase, tgt_phrase FROM ignored WHERE project_id=? ORDER BY id', (project_id,))
    rows = cursor.fetchall()
    cursor.execute('SELECT src_phrase, tgt_phrase FROM phrases WHERE project_id=? AND ignore=? '
                   'ORDER BY num_occurrences DESC', (project_id, HIDDEN_BY_USER))
    rows += cursor.fetchall()
    for src, tgt in rows:
        if (src, tgt) in seen:
            continue
        seen.add((src, tgt))
        out.append({"src": detokenise(src) if src else "", "tgt": detokenise(tgt) if tgt else ""})
    return out


def parse_ignore_list(file_content):
    """
    Entries of a hide-list file, as (src, tgt) pairs of untokenised text:

    - JSON: a list of {"src": ..., "tgt": ...}; a missing or empty side is a
      wildcard ("hide this word whatever it is aligned to").
    - Plain text: one entry per line, "#" starts a comment; "src<TAB>tgt" or
      "src ||| tgt" is a pair, a line without separator is a source wildcard.
    """
    text = (file_content or "").lstrip("\ufeff")
    stripped = text.strip()
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError as e:
            raise ValueError(f"The file is not valid JSON (line {e.lineno}: {e.msg}).")
        if not isinstance(data, list):
            raise ValueError('Expected a JSON list like [{"src": "...", "tgt": "..."}].')
        entries = []
        for i, item in enumerate(data, 1):
            if not isinstance(item, dict):
                raise ValueError(f"Entry {i} is not an object with src/tgt.")
            src = str(item.get("src") or "").strip()
            tgt = str(item.get("tgt") or "").strip()
            if src or tgt:
                entries.append((src, tgt))
        return entries

    entries = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "\t" in line:
            src, tgt = line.split("\t", 1)
        elif "|||" in line:
            src, tgt = line.split("|||", 1)
        else:
            src, tgt = line, ""
        src, tgt = src.strip(), tgt.strip()
        if src or tgt:
            entries.append((src, tgt))
    return entries


def import_ignored_from_file(project_id, file_content):
    """Add the entries of a hide-list file. Returns (entries in file, new entries)."""
    entries = parse_ignore_list(file_content)
    if not entries:
        raise ValueError("The file contains no entries.")
    phrases = [{
        "src_phrase": tokenise(src, as_string=True) if src else "",
        "tgt_phrase": tokenise(tgt, as_string=True) if tgt else "",
    } for src, tgt in entries]
    added = add_phrases_to_ignore(project_id, phrases)
    print(f"Hide list: {len(entries)} entries read, {added} new, for project {project_id}")
    return len(entries), added

def get_all_phrases(project_id):
    """
    Get all phrases for a project as a list of dictionaries.
    Returns phrases with src_phrase, tgt_phrase, direction, num_occurrences.
    """
    _, cursor = get_db()
    
    cursor.execute("""
        SELECT src_phrase, tgt_phrase, direction, num_occurrences
        FROM phrases
        WHERE project_id=?
        ORDER BY num_occurrences DESC
    """, (project_id,))
    
    phrases = cursor.fetchall()
    
    result = []
    for row in phrases:
        result.append({
            "src_phrase": detokenise(row[0]),
            "tgt_phrase": detokenise(row[1]),
            "direction": row[2],
            "num_occurrences": row[3]
        })
    
    return result

def get_symmetric_phrases(project_id):
    """
    Get all phrases for a project as a list of dictionaries.
    Returns phrases with src_phrase, tgt_phrase, direction, num_occurrences.
    """
    _, cursor = get_db()
    
    cursor.execute("""
        SELECT src_phrase, tgt_phrase, direction, num_occurrences
        FROM phrases
        WHERE project_id=? AND direction=0
        ORDER BY num_occurrences DESC
    """, (project_id,))
    
    phrases = cursor.fetchall()
    
    result = []
    for row in phrases:
        result.append({
            "src_phrase": detokenise(row[0]),
            "tgt_phrase": detokenise(row[1]),
            "direction": row[2],
            "num_occurrences": row[3]
        })
    
    return result