"""Reference per-token and per-word surprisal from PyTorch GPT-2.

Writes test/fixtures/reference/<passage>.<model>.json for the opt-in slow test,
which runs the browser scoring core in Node and compares.

The windowing reproduces src/surprisal/windows.ts (planWindow) exactly, so the
two implementations see identical inputs. Words are mapped to tokens through
the fast tokenizer's character offsets: an alignment method independent of the
token-string grouping the app uses.

Usage:
    python -m venv .venv
    .venv/Scripts/pip install torch --index-url https://download.pytorch.org/whl/cpu
    .venv/Scripts/pip install transformers
    .venv/Scripts/python scripts/reference_surprisal.py [--model gpt2] [--window 512] [--stride 256]
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
PASSAGES = ROOT / "test" / "fixtures" / "passages"
OUT = ROOT / "test" / "fixtures" / "reference"


def plan_windows(n: int, window: int, stride: int):
    """Sequential windows from the start, as planWindow does with cursor 1."""
    done = 0
    while done < n - 1:
        j = done + 1
        to = j - 1 + stride
        if to <= window:
            to = window
        to = min(to, n - 1)
        start = max(0, to - window)
        yield start, to, j
        done = to


def word_initial_ids(tok):
    """Tokens whose text starts with whitespace, plus EOS (boundary correction)."""
    ids = [i for i in range(len(tok)) if tok.decode([i], clean_up_tokenization_spaces=False)[:1].isspace()]
    if tok.eos_token_id not in ids:
        ids.append(tok.eos_token_id)
    return torch.tensor(sorted(ids))


def score(text: str, tok, model, window: int, stride: int, bow_ids):
    enc = tok(text, return_offsets_mapping=True, add_special_tokens=False)
    body = enc["input_ids"]
    offsets = [(None, None)] + [tuple(o) for o in enc["offset_mapping"]]
    ids = [tok.bos_token_id] + body
    n = len(ids)
    bits = [float("nan")] * n
    # -log2 of the word-initial mass in the distribution predicting token j.
    bow_bits = [float("nan")] * n
    with torch.no_grad():
        for start, end, first in plan_windows(n, window, stride):
            inp = torch.tensor([ids[start:end]])
            logits = model(inp).logits[0].double()
            logp = torch.log_softmax(logits, dim=-1)
            bow = -torch.logsumexp(logp[:, bow_ids], dim=-1) / math.log(2)
            for j in range(first, end + 1):
                row = j - 1 - start
                bits[j] = -logp[row, ids[j]].item() / math.log(2)
                bow_bits[j] = bow[row].item()

    # Whitespace-delimited words with their character spans.
    words = []
    pos = 0
    for para in text.split("\n\n"):
        for w in para.split(" "):
            idx = text.index(w, pos)
            words.append((w, idx, idx + len(w)))
            pos = idx + len(w)

    # Assign each token to the word that contains its first non-space character.
    word_bits = [0.0] * len(words)
    word_tokens = [0] * len(words)
    word_first = [None] * len(words)
    word_last = [None] * len(words)
    wi = 0
    for j in range(1, n):
        s, e = offsets[j]
        piece = text[s:e]
        if piece.strip() == "":
            continue
        s += len(piece) - len(piece.lstrip())
        while words[wi][2] <= s:
            wi += 1
        assert words[wi][1] <= s < words[wi][2], (j, piece, words[wi])
        word_bits[wi] += bits[j]
        word_tokens[wi] += 1
        if word_first[wi] is None:
            word_first[wi] = j
        word_last[wi] = j

    assert all(c > 0 for c in word_tokens), "a word received no tokens"

    # Boundary-corrected word surprisal: s + B(after) - B(before), where "before" applies only
    # when the word is preceded by a space (not at the start of the text or of a paragraph).
    word_bits_bc = []
    for k, (w, ws, we) in enumerate(words):
        before = bow_bits[word_first[k]] if ws > 0 and text[ws - 1] == " " else 0.0
        nxt = word_last[k] + 1
        after = bow_bits[nxt] if nxt < n else 0.0
        word_bits_bc.append(word_bits[k] + after - before)
    return {
        "ids": ids,
        "token_bits": [None if math.isnan(b) else b for b in bits],
        "words": [w for w, _, _ in words],
        "word_bits": word_bits,
        "word_tokens": word_tokens,
        "word_bits_bc": word_bits_bc,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gpt2")
    ap.add_argument("--window", type=int, default=512)
    ap.add_argument("--stride", type=int, default=256)
    args = ap.parse_args()

    torch.manual_seed(0)
    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32)
    model.eval()
    OUT.mkdir(parents=True, exist_ok=True)
    bow_ids = word_initial_ids(tok)

    for path in sorted(PASSAGES.glob("*.txt")):
        text = path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()
        result = score(text, tok, model, args.window, args.stride, bow_ids)
        result.update(
            model=args.model,
            window=args.window,
            stride=args.stride,
            torch=torch.__version__,
            passage=path.stem,
        )
        out = OUT / f"{path.stem}.{args.model.replace('/', '_')}.json"
        out.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        mean = sum(result["word_bits"]) / len(result["word_bits"])
        print(f"{out.relative_to(ROOT)}: {len(result['ids'])} tokens, {len(result['words'])} words, mean {mean:.2f} bits/word")


if __name__ == "__main__":
    main()
