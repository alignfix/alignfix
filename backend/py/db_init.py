import sqlite3

db_path = "/data/alignfix.db"

# # DEBUG: delete existing db
# try:
#     import os
#     os.remove(db_path)
# except FileNotFoundError:
#     pass

conn = sqlite3.connect(db_path)
c = conn.cursor()
c.execute("""
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY, 
    name TEXT, 
    min_phrase_len INTEGER DEFAULT 1, 
    max_phrase_len INTEGER DEFAULT 3, 
    file_offset INTEGER DEFAULT 0, 
    min_count INTEGER DEFAULT 2, 
    max_count INTEGER DEFAULT 300, 
    threshold INTEGER DEFAULT 1, 
    max_phrases INTEGER DEFAULT 500000,
    stats TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
)
""")
c.execute("""
CREATE TABLE IF NOT EXISTS alignments (
    row_id INTEGER, 
    line1 TEXT, 
    line2 TEXT, 
    alignment TEXT,
    score FLOAT, 
    synced_at TIMESTAMP,
    project_id INTEGER,
    deleted_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id),
    PRIMARY KEY (project_id, row_id)
)
""")
c.execute("""
CREATE TABLE IF NOT EXISTS phrases (
    id INTEGER PRIMARY KEY, 
    src_phrase TEXT, 
    tgt_phrase TEXT, 
    direction TEXT,
    num_occurrences INTEGER,
    project_id INTEGER,     
    is_synced INTEGER,     
    ignore INTEGER DEFAULT 0,
    deleted_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id)
)
""")
c.execute("""
CREATE TABLE IF NOT EXISTS fixes (
    id INTEGER PRIMARY KEY, 
    src_phrase TEXT,
    src_fix TEXT,
    tgt_phrase TEXT,
    tgt_fix TEXT,
    direction TEXT,
    percentage INTEGER,
    num_occurrences INTEGER,
    type TEXT,
    project_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id)
)
""")
c.execute("""
CREATE TABLE IF NOT EXISTS occurrences (
    row_id INTEGER,
    id_phrases INTEGER, 
    project_id INTEGER,
    FOREIGN KEY(id_phrases) REFERENCES phrases(id),
    FOREIGN KEY(row_id) REFERENCES alignments(id),
    PRIMARY KEY (row_id, id_phrases, project_id)
)
""")
c.execute("""
CREATE TABLE IF NOT EXISTS ignored (
    id INTEGER PRIMARY KEY, 
    src_phrase TEXT,
    tgt_phrase TEXT,
    imported INTEGER DEFAULT 0,
    project_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id)
)
""")

# Review: sentence pairs a person checked and accepted. A pair mark
# holds a hash of the text it was given for: once the text changes, it lapses.
c.execute("""
CREATE TABLE IF NOT EXISTS review_marks (
    project_id INTEGER,
    row_id INTEGER,
    status TEXT DEFAULT 'ok',
    text_hash TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, row_id)
)
""")
# The glossary: translation pairs a person confirmed (glossary.py).
c.execute("""
CREATE TABLE IF NOT EXISTS glossary (
    id INTEGER PRIMARY KEY,
    project_id INTEGER,
    src TEXT,
    tgt TEXT,
    origin TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (project_id, src, tgt)
)
""")
# Every change to the sentences: one entry per sentence pair and action (batch),
# with the text before and after, for the change report of the download.
c.execute("""
CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY,
    project_id INTEGER,
    batch INTEGER,
    row_id INTEGER,
    action TEXT,
    reason TEXT,
    origin_row INTEGER,
    old_line1 TEXT,
    old_line2 TEXT,
    new_line1 TEXT,
    new_line2 TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (project_id, batch, row_id)
)
""")
c.execute("""
CREATE INDEX IF NOT EXISTS idx_changes_row
ON changes (project_id, row_id)
""")

c.execute("""
CREATE INDEX IF NOT EXISTS idx_phrases_lookup
ON phrases (src_phrase, tgt_phrase, direction, project_id)
""")

c.execute("""
CREATE INDEX IF NOT EXISTS idx_occurrences_phrase
ON occurrences (id_phrases, project_id)
""")

c.execute("""
CREATE INDEX IF NOT EXISTS idx_occurrences_row
ON occurrences (row_id, project_id)
""")

# One entry per (project, src, tgt) in the hide list: remove duplicates left by
# older versions (keeping the first), then let the index prevent new ones.
c.execute("""
DELETE FROM ignored WHERE id NOT IN (
    SELECT MIN(id) FROM ignored GROUP BY project_id, src_phrase, tgt_phrase
)
""")
c.execute("""
CREATE UNIQUE INDEX IF NOT EXISTS idx_ignored_unique
ON ignored (project_id, src_phrase, tgt_phrase)
""")

c.execute("""
CREATE INDEX IF NOT EXISTS idx_fixes_lookup
ON fixes (src_phrase, tgt_phrase, direction, project_id)
""")


conn.commit()
conn.close()
