import html
import re

from utils import find_all_sublists

SPLIT_SYMBOLS = [
    "'",
    "!",
    '"',
    "$",
    "%",
    "&",
    "\\",
    "(",
    ")",
    ".",
    "*",
    "+",
    ";",
    "@",
    "^",
    "`",
    "_",
    "|",
    "~",
    "-",
    "]",
    "[",
    "}",
    "{",
    "€",
    "§",
    "<",
    ">",
    ";",
    "!",
    "'",
    "?",
    ",",
    "/",
    ":",
    '"',
    "=",
    "»",
    "«",
]

NO_BLANK_TOKEN = "#NB"
BLANK_TOKEN = "#BLANK"

SKIP_SYMBOLS = SPLIT_SYMBOLS + [BLANK_TOKEN, NO_BLANK_TOKEN]


def detokenise(text, as_list=False):
    if isinstance(text, list):
        text = " ".join([str(x) for x in text])

    text = re.sub(rf'\s*{NO_BLANK_TOKEN}\s*', '', text)
    text = re.sub(rf'\s*{BLANK_TOKEN}\s*', ' ', text)

    if as_list:
        return text.split()

    return text

def create_content_search(text):

    words = tokenise(text)
    words = [w for w in words if w not in SKIP_SYMBOLS]
    return words

def strip_nb_bl(tokens):
    # if first token is Blank or no blank, strip
    if tokens and (tokens[0] == BLANK_TOKEN or tokens[0] == NO_BLANK_TOKEN):
        tokens = tokens[1:]

    # if last token is Blank or no blank, strip
    if tokens and (tokens[-1] == BLANK_TOKEN or tokens[-1] == NO_BLANK_TOKEN):
        tokens = tokens[:-1]

    return tokens

# Must behave exactly like tokenise() in backend/c/text_tokenize.cc, which
# tokenizes uploaded corpora: phrases, fixes and edited lines tokenized here are
# matched against (and inserted into) those stored lines.
_SPLIT_SET = set(SPLIT_SYMBOLS)
_WHITESPACE = set(" \t\n\v\f\r")   # C isspace() in the "C" locale
_C_BLANK = "#BL"                     # the C tokenizer's internal blank marker


def tokenise(text, as_string=False):

    if isinstance(text, list):
        text = " ".join(text)

    if not text.strip():
        return ''

    parts = []
    for ch in text:
        if ch in _SPLIT_SET:
            parts.append(f" {NO_BLANK_TOKEN} {ch} {NO_BLANK_TOKEN} ")
        elif ch in _WHITESPACE:
            parts.append(f" {_C_BLANK} ")
        else:
            parts.append(ch)

    tokens = []
    for token in "".join(parts).split(" "):
        if not token:
            continue
        if tokens:
            prev = tokens[-1]
            if token == _C_BLANK and prev == NO_BLANK_TOKEN:
                tokens[-1] = _C_BLANK      # NB followed by blank becomes a blank
                continue
            if token == NO_BLANK_TOKEN and prev in (_C_BLANK, NO_BLANK_TOKEN):
                continue                   # NB after a blank, or duplicate NB
        tokens.append(token)

    last = len(tokens) - 1
    tokens = [
        t for i, t in enumerate(tokens)
        if t != _C_BLANK and not ((i == 0 or i == last) and t == NO_BLANK_TOKEN)
    ]

    # The JS side trims the C output (String.trim also removes Unicode spaces)
    joined = " ".join(tokens).strip()
    if as_string:
        return joined

    return joined.split(" ") if joined else []


def highlight_tokens(tok_str, tok_to_highlight, replace_with_str, css_class="src-occurrence"):
    """
    Return the tokens of tok_str as HTML-escaped strings, with every occurrence
    of tok_to_highlight replaced by a highlight span around replace_with_str
    (also escaped). The result is meant to be passed to detokenise().
    """
    raw_tok = tok_str.split()
    escaped = [html.escape(t) for t in raw_tok]

    if tok_to_highlight:
        # indices are sorted descending, so replacing does not shift later matches
        for start in find_all_sublists(raw_tok, tok_to_highlight):
            escaped[start:start + len(tok_to_highlight)] = [
                f"<span class='occurrence {css_class}'>{html.escape(str(replace_with_str))}</span>"
            ]

    return escaped
