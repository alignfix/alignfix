# py/lexicon.py
"""
Corpus-level lexical translation statistics derived from the stored
(symmetrized) word alignments, plus the per-token scores built on them.

For every word w on either side we estimate an *outcome distribution*:

    O(w) = { NULL: 1 - r(w) }  ∪  { t: r(w) · p(t | w) }

where r(w) is the (smoothed) rate at which w is aligned at all, and p(t | w)
the relative frequency of aligned partners t. The entropy H(O(w)) says how
predictable the translation of w is (used for translation difficulty), and
the surprisal of what a sentence actually contains, compared with H(O(w)),
says how *unexpected* it is (used for alignment consistency).
"""
import math
from collections import Counter, defaultdict

from alignment import parse_alignment
from text import SKIP_SYMBOLS

SKIP_TOKENS = set(SKIP_SYMBOLS)

# Words seen fewer times than this get no statistics (too noisy).
MIN_SUPPORT = 20
# Additive smoothing of the aligned rate r(w) = (a + ALPHA) / (n + ALPHA + BETA).
ALPHA = 1.0
BETA = 1.0


def normalize(token):
    return token.lower()


def is_content(token):
    """Skip punctuation and the tokenizer's #NB / #BLANK markers."""
    return token not in SKIP_TOKENS and any(ch.isalnum() for ch in token)


def _parse_links(alignment, n_src, n_tgt):
    try:
        links = parse_alignment(alignment or "")
    except ValueError:
        return []
    return [(s, t) for s, t in links if 0 <= s < n_src and 0 <= t < n_tgt]


def _entropy(probs):
    return -sum(p * math.log(p) for p in probs if p > 0)


class Side:
    """Statistics for the words of one side (source or target)."""

    def __init__(self):
        self.count = Counter()     # n(w): content-token occurrences
        self.aligned = Counter()   # a(w): occurrences with at least one link
        self.links = defaultdict(Counter)  # w -> partner -> link count

        # filled by finalize()
        self.rate = {}             # r(w)
        self.translations = {}     # w -> {partner: p(partner | w)}
        self.entropy = {}          # H(O(w)) in nats

    def finalize(self, min_support):
        for w, n in self.count.items():
            if n < min_support:
                continue
            r = (self.aligned[w] + ALPHA) / (n + ALPHA + BETA)
            partners = self.links.get(w)
            total = sum(partners.values()) if partners else 0
            probs = {t: c / total for t, c in partners.items()} if total else {}
            self.rate[w] = r
            self.translations[w] = probs
            self.entropy[w] = _entropy([1 - r] + [r * p for p in probs.values()])
        # raw link counts are no longer needed
        self.links = None

    def supported(self, w):
        return w in self.rate


class Lexicon:
    def __init__(self, min_support=MIN_SUPPORT):
        self.min_support = min_support
        self.src = Side()
        self.tgt = Side()

    @classmethod
    def build(cls, rows, min_support=MIN_SUPPORT):
        """rows: iterable of (line1, line2, alignment) with tokenised lines."""
        lex = cls(min_support)
        rows = list(rows)

        # Pass 1: unigram counts, so link counts can be restricted to supported
        # words (keeps memory bounded on large corpora).
        for line1, line2, _ in rows:
            for tok in line1.split():
                if is_content(tok):
                    lex.src.count[normalize(tok)] += 1
            for tok in line2.split():
                if is_content(tok):
                    lex.tgt.count[normalize(tok)] += 1

        src_ok = {w for w, n in lex.src.count.items() if n >= min_support}
        tgt_ok = {w for w, n in lex.tgt.count.items() if n >= min_support}

        # Pass 2: aligned rates and link counts.
        for line1, line2, alignment in rows:
            src = [normalize(t) if is_content(t) else None for t in line1.split()]
            tgt = [normalize(t) if is_content(t) else None for t in line2.split()]
            links = _parse_links(alignment, len(src), len(tgt))

            src_aligned = {s for s, _ in links}
            tgt_aligned = {t for _, t in links}
            for i, w in enumerate(src):
                if w is not None and i in src_aligned:
                    lex.src.aligned[w] += 1
            for j, w in enumerate(tgt):
                if w is not None and j in tgt_aligned:
                    lex.tgt.aligned[w] += 1

            for s, t in links:
                ws, wt = src[s], tgt[t]
                if ws is None or wt is None:
                    continue
                if ws in src_ok and wt in tgt_ok:
                    lex.src.links[ws][wt] += 1
                    lex.tgt.links[wt][ws] += 1

        lex.src.finalize(min_support)
        lex.tgt.finalize(min_support)
        return lex
