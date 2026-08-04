#!/usr/bin/env python3
"""Batch pre-generate TTS mp3s for every card text.

Usage: pregen_tts.py <texts.txt> <out_dir> <voice> [concurrency]

Each line of texts.txt becomes <out_dir>/<sha1(text)>.mp3 — the exact naming
the web server's /api/tts endpoint uses, so files land directly in its cache.
Existing non-empty files are skipped, so re-runs are cheap and safe.
"""
import asyncio
import hashlib
import os
import sys

import edge_tts


def main():
    texts_file, out_dir, voice = sys.argv[1], sys.argv[2], sys.argv[3]
    conc = int(sys.argv[4]) if len(sys.argv) > 4 else 6
    texts = [l for l in open(texts_file, encoding="utf8").read().split("\n") if l.strip()]
    os.makedirs(out_dir, exist_ok=True)

    def fname(t):
        return os.path.join(out_dir, hashlib.sha1(t.encode()).hexdigest() + ".mp3")

    todo = [
        t
        for t in texts
        if not (os.path.exists(fname(t)) and os.path.getsize(fname(t)) > 0)
    ]
    print(f"total={len(texts)} cached={len(texts) - len(todo)} todo={len(todo)}", flush=True)

    sem = asyncio.Semaphore(conc)
    state = {"done": 0}
    failed = []

    async def gen(t):
        async with sem:
            f = fname(t)
            for attempt in range(4):
                try:
                    await edge_tts.Communicate(t, voice).save(f)
                    if os.path.getsize(f) > 0:
                        break
                    raise RuntimeError("empty file")
                except Exception as e:
                    if attempt == 3:
                        print(f"FAIL {t!r}: {e}", flush=True)
                    await asyncio.sleep(2 * (attempt + 1))
            else:
                failed.append(t)
                return
            state["done"] += 1
            if state["done"] % 200 == 0:
                print(f"progress {state['done']}/{len(todo)}", flush=True)

    async def run():
        await asyncio.gather(*(gen(t) for t in todo))

    asyncio.run(run())
    print(f"DONE ok={state['done']} failed={len(failed)}", flush=True)
    if failed:
        with open(os.path.join(out_dir, "pregen_failed.txt"), "w", encoding="utf8") as fh:
            fh.write("\n".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
