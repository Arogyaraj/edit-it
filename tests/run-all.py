"""Runs every test suite in this folder and prints a summary. Run: python3 tests/run-all.py
Exits non-zero if any suite fails. Each suite starts its own local server and headless browser."""
import subprocess, sys, os, re, time

HERE = os.path.dirname(os.path.abspath(__file__))
SUITES = [
    'browser-tests.py', 'layers-tests.py', 'canvas-tests.py', 'polish-tests.py', 'extras-tests.py',
    'ui-tests.py', 'ui-polish-tests.py', 'tools-tests.py', 'features-tests.py', 'next-tests.py',
    'hard-tests.py', 'smart-tests.py', 'pinch-tests.py', 'mobile-tests.py', 'console-tests.py',
]

def main():
    failed, totals = [], []
    start = time.time()
    for name in SUITES:
        t0 = time.time()
        proc = subprocess.run([sys.executable, os.path.join(HERE, name)], capture_output=True, text=True, timeout=900)
        out = proc.stdout + proc.stderr
        m = re.search(r'(\d+)/(\d+) checks passed', out)
        status = 'PASS' if proc.returncode == 0 and m else 'FAIL'
        detail = f'{m.group(1)}/{m.group(2)}' if m else 'no summary'
        if m:
            totals.append((int(m.group(1)), int(m.group(2))))
        if status == 'FAIL':
            failed.append(name)
            fails = [l for l in out.splitlines() if l.startswith('FAIL') or 'Error' in l][:5]
            print('\n'.join(fails))
        print(f'{status}  {name:<22} {detail:>8}  ({time.time() - t0:.0f}s)', flush=True)
    done = sum(a for a, _ in totals), sum(b for _, b in totals)
    print(f'\n{done[0]}/{done[1]} checks passed across {len(SUITES)} suites in {time.time() - start:.0f}s')
    if failed:
        print('Failed suites:', ', '.join(failed))
        sys.exit(1)

if __name__ == '__main__':
    main()
