#!/bin/sh
# Proves analyze-audio.py detects what it claims to, on synthetic audio (needs ffmpeg).
# A check that cannot fail is worthless: each FAIL case below must exit 1, each PASS case 0.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail=0

tone() { # tone <out> <seconds>
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=$2" "$1"
}
tone_with_gap() { # tone_with_gap <out> <total> <gap_start> <gap_len>   (a hole of silence in a continuous tone)
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=$2" \
    -af "volume=enable='between(t,$3,$3+$4)':volume=0" "$1"
}
expect() { # expect <exit code wanted> <label> <command...>
  want=$1; label=$2; shift 2
  "$@" >/dev/null 2>&1; got=$?
  if [ "$got" -eq "$want" ]; then echo "ok   $label"; else echo "FAIL $label (exit $got, wanted $want)"; fail=1; fi
}

tone "$T/clean.wav" 30
tone_with_gap "$T/gap_in_scan.wav" 30 10 0.8
tone_with_gap "$T/short_gap_in_scan.wav" 30 10 0.3
tone_with_gap "$T/gap_elsewhere.wav" 30 25 0.8

A="python3 $HERE/analyze-audio.py"
expect 0 "continuous audio, scan window given, right duration      → PASS"        $A "$T/clean.wav" --real-seconds 30 --scans 9000:12000
expect 1 "0.8 s hole INSIDE a scan window                          → FAIL"        $A "$T/gap_in_scan.wav" --real-seconds 30 --scans 9000:12000
expect 0 "0.3 s hole inside a scan window (below 500 ms)           → PASS"        $A "$T/short_gap_in_scan.wav" --real-seconds 30 --scans 9000:12000
expect 0 "0.8 s hole well OUTSIDE the scan window (warning only)   → PASS"        $A "$T/gap_elsewhere.wav" --real-seconds 30 --scans 9000:12000
expect 1 "file shorter than the real record (30 s vs 33 s real)    → FAIL"        $A "$T/clean.wav" --real-seconds 33 --scans 9000:12000
expect 0 "duration within ±1 s (30 s vs 30.8 s real)               → PASS"        $A "$T/clean.wav" --real-seconds 30.8 --scans 9000:12000
expect 1 "hole 1.2 s after the window end, inside the 1.5 s margin → FAIL"        $A "$T/gap_in_scan.wav" --real-seconds 30 --scans 6000:8800
# report JSON path (what the app's "Copy report" produces)
printf '{"scans":[{"label":"5 pages","audioWindowMs":[9000,12000]}]}' > "$T/report.json"
expect 1 "scan window taken from the app report                    → FAIL"        $A "$T/gap_in_scan.wav" --real-seconds 30 --report "$T/report.json"

exit $fail
