# py/issues.py
"""
Translation issues: tokens and sentence pairs that look wrong, as opposed to
words that are merely translated in many (valid) ways.

Word level. From the word alignments we learn, for every word w seen at least
MIN_SUPPORT times, its *usual translations*: aligned partners with a share of
at least MIN_TRANSLATION_SHARE (inflections merged by their first STEM_LENGTH
letters). Then, without looking at the alignment again, we count in how many
sentence pairs at least one usual translation of w occurs anywhere on the other
side: the *explanation rate* e(w). In a sentence pair where none occurs, w is
unexplained, and how surprising that is depends on the word:

    surprise(w) = -ln(1 - e(w))      (e smoothed: (k + 1) / (n + 2))

A word that is often paraphrased or dropped ("tomorrow's") has a low e(w) and
is rarely worth a look; a word whose translation nearly always appears
("rain" -> "pioggia", e = 0.97) is very surprising when it does not. A
synonym is not a problem: it is one of the usual translations, or a word that
is often paraphrased anyway. Only surprises above SURPRISE_THRESHOLD count:

    - source word unexplained: possibly omitted or mistranslated
    - target word unexplained: possibly added (hallucinated) or mistranslated

Sentence level, independent of the lexicon:

    - numbers that occur on one side only
    - the target repeating a word sequence the source does not repeat
    - a length ratio far outside the corpus norm
    - the target being a copy of the source (untranslated)

The issue score of a sentence pair is the sum of its surprises above the
threshold (0 = nothing found). On a real German-Italian corpus with injected
errors, 75 of the 100 highest-scoring pairs were injected errors (and most of
the others real mismatches), against 3 for the previous alignment-consistency
score and the per-word variant counts.
"""
import math
import re
from collections import Counter, defaultdict

from alignment import parse_alignment
from lexicon import normalize, is_content

MIN_SUPPORT = 20
MIN_TRANSLATION_SHARE = 0.05
MAX_TRANSLATIONS = 20
MIN_REVERSE_SHARE = 0.05         # ... and w must take at least this share of the partner's links
STEM_LENGTH = 5
SURPRISE_THRESHOLD = math.log(5)   # unexplained in at most 1 of 5 other sentences
NUMBER_SURPRISE = 3.0
REPEAT_SURPRISE = 3.0
COPY_SURPRISE = 5.0
LENGTH_Z = 4.0                     # robust z-score of the log length ratio
EXAMPLES_KEPT = 3

_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")

KIND_LABELS = {
    "missing": "no usual translation on the other side",
    "unexplained": "not explained by the source",
    "number": "number on one side only",
    "repeated": "repeated words",
    "length": "unusual length ratio",
    "copy": "target is a copy of the source",
}


def stem(word):
    return word[:STEM_LENGTH]


def _words(line):
    """(position, normalised word) of the lexical content tokens: no punctuation, no numbers."""
    out = []
    for i, tok in enumerate((line or "").split()):
        if is_content(tok) and not any(ch.isdigit() for ch in tok):
            out.append((i, normalize(tok)))
    return out


def _numbers(line):
    return Counter(m.group().replace(",", ".") for m in _NUMBER.finditer(line or ""))


class SideModel:
    def __init__(self):
        self.translations = {}   # w -> set of partner stems
        self.display = {}        # w -> [most frequent partner words]
        self.rate = {}           # w -> e(w)
        self.sentences = {}      # w -> sentences containing w
        self.baseline = {}       # w -> share of other-side sentences containing a usual translation


class IssueModel:
    def __init__(self):
        self.src = SideModel()
        self.tgt = SideModel()
        self.length_median = 0.0
        self.length_mad = 0.0

    @classmethod
    def build(cls, rows):
        steps = cls.build_steps(rows)
        while True:
            try:
                next(steps)
            except StopIteration as done:
                return done.value

    @classmethod
    def build_steps(cls, rows, every=5000):
        """Generator yielding progress (0..1), returning the model (see progress.drive)."""
        rows = list(rows)
        model = cls()
        total = 3 * len(rows) or 1
        words = []

        # pass 1: sentence frequencies and length ratios
        df = (Counter(), Counter())
        ratios = []
        for i, (line1, line2, _) in enumerate(rows):
            if i % every == 0:
                yield i / total
            ws, wt = _words(line1), _words(line2)
            words.append((ws, wt))
            df[0].update({w for _, w in ws})
            df[1].update({w for _, w in wt})
            n1, n2 = len((line1 or "").split()), len((line2 or "").split())
            if n1 and n2:
                ratios.append(math.log(n2 / n1))
        known = ({w for w, n in df[0].items() if n >= MIN_SUPPORT},
                 {w for w, n in df[1].items() if n >= MIN_SUPPORT})
        if ratios:
            ratios.sort()
            model.length_median = ratios[len(ratios) // 2]
            deviations = sorted(abs(r - model.length_median) for r in ratios)
            model.length_mad = deviations[len(deviations) // 2] or 0.1

        # pass 2: aligned partners of the known words
        links = (defaultdict(Counter), defaultdict(Counter))
        for i, (line1, line2, alignment) in enumerate(rows):
            if i % every == 0:
                yield (len(rows) + i) / total
            src = dict(words[i][0])
            tgt = dict(words[i][1])
            try:
                pairs = parse_alignment(alignment or "")
            except ValueError:
                continue
            for s, t in pairs:
                ws, wt = src.get(s), tgt.get(t)
                if ws is None or wt is None:
                    continue
                if ws in known[0]:
                    links[0][ws][wt] += 1
                if wt in known[1]:
                    links[1][wt][ws] += 1

        # all links of every partner word, for the reverse share
        partner_links = (Counter(), Counter())
        for side in (0, 1):
            for partners in links[side].values():
                partner_links[side].update(partners)
        for side, model_side in ((0, model.src), (1, model.tgt)):
            for w, partners in links[side].items():
                total_links = sum(partners.values())
                # a usual translation is linked to w often, and w is a usual source of it:
                # "der" is linked to many words but is not a translation of "sabato"
                good = {p: n for p, n in partners.items()
                        if n / partner_links[side][p] >= MIN_REVERSE_SHARE}
                by_stem = Counter()
                for partner, n in good.items():
                    by_stem[stem(partner)] += n
                stems = {s for s, n in by_stem.most_common(MAX_TRANSLATIONS)
                         if n / total_links >= MIN_TRANSLATION_SHARE}
                if not stems:
                    continue
                model_side.translations[w] = stems
                model_side.display[w] = [p for p, _ in Counter(good).most_common(EXAMPLES_KEPT)
                                         if stem(p) in stems]

        # pass 3: explanation rates
        explained = (Counter(), Counter())
        stem_sentences = (defaultdict(list), defaultdict(list))   # stem -> sentences containing it
        for i, (ws, wt) in enumerate(words):
            for side, mine in ((0, ws), (1, wt)):
                for st in {stem(w) for _, w in mine}:
                    stem_sentences[side][st].append(i)
            if i % every == 0:
                yield (2 * len(rows) + i) / total
            for side, mine, other in ((0, ws, wt), (1, wt, ws)):
                model_side = model.src if side == 0 else model.tgt
                other_stems = {stem(w) for _, w in other}
                for w in {w for _, w in mine}:
                    stems = model_side.translations.get(w)
                    if stems and not stems.isdisjoint(other_stems):
                        explained[side][w] += 1
        n_rows = len(rows) or 1
        for side, model_side in ((0, model.src), (1, model.tgt)):
            other_index = stem_sentences[1 - side]
            for w, stems in model_side.translations.items():
                n = df[side][w]
                model_side.sentences[w] = n
                model_side.rate[w] = (explained[side][w] + 1) / (n + 2)
                # chance that a random sentence of the other side contains a usual translation
                hits = set()
                for st in stems:
                    hits.update(other_index.get(st, ()))
                model_side.baseline[w] = len(hits) / n_rows
        return model

    def surprise(self, side, word):
        """-ln P(no usual translation | word): how unusual a missing translation is (nats)."""
        rate = (self.src if side == "src" else self.tgt).rate.get(word)
        return -math.log(1 - rate) if rate is not None else 0.0

    def lift(self, side, word):
        """
        How much rarer a missing translation is next to `word` than in a random
        sentence (nats). Low for function words, whose usual translations
        appear almost everywhere anyway, so their absence says little.
        """
        model_side = self.src if side == "src" else self.tgt
        rate = model_side.rate.get(word)
        if rate is None:
            return 0.0
        return math.log((1 - model_side.baseline[word] + 1e-9) / (1 - rate))


def _word_issues(model, side, mine, other):
    model_side = model.src if side == "src" else model.tgt
    other_stems = {stem(w) for _, w in other}
    found = []
    seen = set()
    for index, w in mine:
        stems = model_side.translations.get(w)
        if not stems or not stems.isdisjoint(other_stems):
            continue
        surprise = model.surprise(side, w)
        if surprise <= SURPRISE_THRESHOLD:
            continue
        found.append({
            "side": side,
            "index": index,
            "word": w,
            "kind": "missing" if side == "src" else "unexplained",
            "anomaly": round(surprise - SURPRISE_THRESHOLD, 3),
            "rate": round(model_side.rate[w], 3),
            # evidence against chance, for ranking words (see lift)
            "lift": round(max(0.0, model.lift(side, w) - SURPRISE_THRESHOLD), 3),
            "expected": model_side.display.get(w, []),
            "repeat": w in seen,
        })
        seen.add(w)
    return found


def _repeated_ngram(tokens, n=3, times=3):
    counts = Counter(tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1))
    return max(counts.values(), default=0) >= times


def sentence_issues(model, line1, line2):
    """
    Issues of one sentence pair, most severe first. Each: side ('src', 'tgt' or
    None for the pair), index (token position or None), word, kind, anomaly
    (> 0), and for word issues the explanation rate and usual translations.
    """
    ws, wt = _words(line1), _words(line2)
    found = _word_issues(model, "src", ws, wt) + _word_issues(model, "tgt", wt, ws)
    # the same word twice in a sentence is one issue
    found = [f for f in found if not f.pop("repeat")]

    n1, n2 = _numbers(line1), _numbers(line2)
    for side, extra in (("src", n1 - n2), ("tgt", n2 - n1)):
        for number in extra:
            found.append({"side": side, "index": None, "word": number, "kind": "number",
                          "anomaly": NUMBER_SURPRISE - SURPRISE_THRESHOLD})

    src_tokens = [w for _, w in ws]
    tgt_tokens = [w for _, w in wt]
    if _repeated_ngram(tgt_tokens) and not _repeated_ngram(src_tokens):
        found.append({"side": "tgt", "index": None, "word": "", "kind": "repeated",
                      "anomaly": REPEAT_SURPRISE - SURPRISE_THRESHOLD})
    if len(src_tokens) >= 3 and src_tokens == tgt_tokens:
        found.append({"side": None, "index": None, "word": "", "kind": "copy",
                      "anomaly": COPY_SURPRISE - SURPRISE_THRESHOLD})
    t1, t2 = len((line1 or "").split()), len((line2 or "").split())
    if t1 and t2 and model.length_mad:
        z = abs(math.log(t2 / t1) - model.length_median) / (1.4826 * model.length_mad)
        if z > LENGTH_Z:
            found.append({"side": None, "index": None, "word": "", "kind": "length",
                          "anomaly": round(min(z - LENGTH_Z, 3.0), 3)})

    found.sort(key=lambda f: f["anomaly"], reverse=True)
    return found


def issue_score(found):
    """Sum of the anomalies; 0 = nothing found."""
    return round(sum(f["anomaly"] for f in found), 3)


def describe(issue):
    """One sentence explaining an issue, for the user."""
    kind = issue["kind"]
    if kind in ("missing", "unexplained"):
        share = f"{issue['rate']:.0%}"
        usual = ", ".join(issue.get("expected") or [])
        where = "target" if kind == "missing" else "source"
        return (f"“{issue['word']}” usually has {('“' + usual + '”') if usual else 'a translation'} "
                f"on the {where} side ({share} of its sentences), not here")
    if kind == "number":
        return f"the number {issue['word']} appears on the {'source' if issue['side'] == 'src' else 'target'} side only"
    if kind == "repeated":
        return "the target repeats a word sequence that the source does not"
    if kind == "copy":
        return "the target is a copy of the source"
    return "the target is much longer or shorter than usual"
