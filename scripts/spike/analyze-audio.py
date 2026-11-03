#!/usr/bin/env python3
"""Audio continuity check for the "Scan a document" spike.

Checks the FINAL audio file of a record in which documents were scanned:
  1. duration equals the real duration within --tolerance seconds (default 1.0);
  2. no silence longer than --min-silence seconds (default 0.5) overlaps a scan window
     (the window plus --margin seconds on each side, default 1.5).
Silences elsewhere in the file are reported as warnings: they are not scan-related, but with the
recommended continuous reference tone any silence at all means the audio dropped.

Use a CONTINUOUS source while testing (human speech has natural pauses that look like dropouts):
  python3 analyze-audio.py --make-counting counting.aiff      # speech: also lets you check the transcript
  python3 analyze-audio.py --make-reference tone.m4a --seconds 180   # pure tone
  afplay counting.aiff                                         # play it next to the phone

Scan windows come from the app's "Copy report" JSON (--report) or --scans 60000:80000,120000:150000
(milliseconds on the audio timeline). Requires ffmpeg + ffprobe on PATH. Exit code: 0 = pass, 1 = fail.
"""
import argparse, json, re, subprocess, sys


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def duration_seconds(path):
    p = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path])
    if p.returncode != 0 or not p.stdout.strip():
        raise SystemExit(f"ffprobe could not read {path}: {p.stderr.strip()}")
    return float(p.stdout.strip())


def silences(path, noise_db, min_silence, total):
    """[(start, end)] in seconds. A silence still open at end of file runs to `total`."""
    p = run(["ffmpeg", "-nostats", "-hide_banner", "-i", path, "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}", "-f", "null", "-"])
    out, start = [], None
    for line in p.stderr.splitlines():
        m = re.search(r"silence_start: ([\d.]+)", line)
        if m:
            start = float(m.group(1)); continue
        m = re.search(r"silence_end: ([\d.]+)", line)
        if m and start is not None:
            out.append((start, float(m.group(1)))); start = None
    if start is not None:
        out.append((start, total))
    return out


def scan_windows(args):
    wins = []
    if args.report:
        data = json.load(open(args.report))
        for s in data.get("scans", []):
            a, b = s["audioWindowMs"]
            wins.append((s.get("label", "scan"), a / 1000.0, b / 1000.0))
    if args.scans:
        for i, part in enumerate(args.scans.split(","), 1):
            a, b = part.split(":")
            wins.append((f"scan {i}", float(a) / 1000.0, float(b) / 1000.0))
    return wins


def analyze(path, real_seconds, windows, tolerance=1.0, min_silence=0.5, margin=1.5, noise_db=-50):
    total = duration_seconds(path)
    sil = silences(path, noise_db, min_silence, total)
    result = {"file": path, "duration_s": round(total, 3), "real_s": real_seconds, "checks": [], "warnings": []}

    ok = abs(total - real_seconds) <= tolerance
    result["checks"].append({"id": "duration", "ok": ok,
                             "detail": f"{total:.2f} s in the file vs {real_seconds:.2f} s real (tolerance ±{tolerance} s)"})

    def overlaps(s, e, w):
        return s < w[2] + margin and e > w[1] - margin

    in_scan = []
    for (a, b) in sil:
        hit = [w[0] for w in windows if overlaps(a, b, w)]
        if hit:
            in_scan.append({"start_s": round(a, 3), "end_s": round(b, 3), "duration_s": round(b - a, 3), "scans": hit})
        else:
            result["warnings"].append(f"silence {a:.2f}–{b:.2f} s ({b - a:.2f} s) outside any scan window")
    result["checks"].append({"id": "no_silence_at_scans", "ok": not in_scan,
                             "detail": "no silence ≥ %.0f ms within %d scan window(s) ±%.1f s" % (min_silence * 1000, len(windows), margin)
                             if not in_scan else f"{len(in_scan)} silence(s) at scan instants", "silences": in_scan})
    if not windows:
        result["warnings"].append("no scan windows given: only the duration was checked")
    result["pass"] = all(c["ok"] for c in result["checks"])
    return result


def make_reference(path, seconds):
    """A continuous tone with a slow wobble: any dropout is unambiguous, and it is easy on the ears."""
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
           f"sine=frequency=440:duration={seconds}", "-af", "tremolo=f=0.5:d=0.3,volume=0.6", path]
    p = run(cmd)
    if p.returncode != 0:
        raise SystemExit(p.stderr)
    print(f"wrote {path} ({seconds} s). Play it next to the phone, e.g.: afplay {path}")


def make_counting(path, repeats=14):
    """macOS only: French counting with no full stops, so the source itself has no pause of 500 ms or more.
    Usable as the audio source for BOTH checks: silences (none in the source) and the server transcript
    (numbers must come out in sequence, none missing around the scans)."""
    import tempfile, os
    words = ["un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize",
             "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf", "vingt"]
    text = " ".join(f"{w}," for _ in range(repeats) for w in words)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(text); tmp = f.name
    try:
        p = run(["say", "-v", "Thomas", "-r", "200", "-o", path, "-f", tmp])
    finally:
        os.unlink(tmp)
    if p.returncode != 0:
        raise SystemExit(p.stderr or "`say` failed (macOS only)")
    total = duration_seconds(path)
    own = silences(path, -45, 0.5, total)
    print(f"wrote {path} ({total:.0f} s), {len(own)} silence(s) of 500 ms or more in the source itself.")
    print(f"Play it next to the phone, e.g.: afplay {path}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", nargs="?")
    ap.add_argument("--real-seconds", type=float, help="true duration of the record (stopwatch)")
    ap.add_argument("--report", help="JSON from the app's 'Copy report'")
    ap.add_argument("--scans", help="scan windows in ms: 60000:80000,120000:150000")
    ap.add_argument("--tolerance", type=float, default=1.0)
    ap.add_argument("--min-silence", type=float, default=0.5)
    ap.add_argument("--margin", type=float, default=1.5)
    ap.add_argument("--noise-db", type=float, default=-50)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--make-reference", metavar="OUT")
    ap.add_argument("--make-counting", metavar="OUT", help="macOS: continuous French counting (speech source for silences + transcript)")
    ap.add_argument("--seconds", type=int, default=180)
    a = ap.parse_args(argv)

    if a.make_counting:
        make_counting(a.make_counting)
        return 0
    if a.make_reference:
        make_reference(a.make_reference, a.seconds)
        return 0
    if not a.audio or a.real_seconds is None:
        ap.error("audio and --real-seconds are required")

    res = analyze(a.audio, a.real_seconds, scan_windows(a), a.tolerance, a.min_silence, a.margin, a.noise_db)
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        print(f"{res['file']}: {res['duration_s']} s")
        for c in res["checks"]:
            print(f"  {'PASS' if c['ok'] else 'FAIL'}  {c['id']}: {c['detail']}")
            for s in c.get("silences", []):
                print(f"        silence {s['start_s']}–{s['end_s']} s ({s['duration_s']} s) during {', '.join(s['scans'])}")
        for w in res["warnings"]:
            print(f"  warn  {w}")
        print("RESULT:", "PASS" if res["pass"] else "FAIL")
    return 0 if res["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
