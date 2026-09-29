"""Runs the seeded reference solutions against their tests (development check only).

Used by problem-bank.test.ts on a developer machine or in CI; it never runs on
an interview server, and candidate code never runs here (it goes to the judge).
Input on stdin: a JSON list of {key, sql: {setup, orderInsensitive} | null,
reference, tests: [{input, expectedOutput}]}. Output: a JSON list of failures.
"""
import io
import json
import sqlite3
import sys


def run_python(code, stdin):
    old_in, old_out = sys.stdin, sys.stdout
    sys.stdin, sys.stdout = io.StringIO(stdin), io.StringIO()
    try:
        exec(compile(code, '<reference>', 'exec'), {'__name__': '__main__'})
        return sys.stdout.getvalue()
    finally:
        sys.stdin, sys.stdout = old_in, old_out


def statements(script):
    buf = ''
    for ch in script:
        buf += ch
        if ch == ';' and sqlite3.complete_statement(buf):
            yield buf
            buf = ''
    if buf.strip():
        yield buf


def value(v):
    if v is None:
        return ''
    return repr(v) if isinstance(v, float) else str(v)


def run_sql(script):
    """Like `sqlite3 db < script` in list mode: each row-returning statement prints its rows."""
    con = sqlite3.connect(':memory:')
    rows = []
    try:
        cur = con.cursor()
        for stmt in statements(script):
            code = [l for l in stmt.splitlines() if l.strip() and not l.strip().startswith('--')]
            if not code:
                continue
            cur.execute(stmt)
            if cur.description is not None:
                rows.extend('|'.join(value(v) for v in row) for row in cur.fetchall())
    finally:
        con.close()
    return ''.join(f'{r}\n' for r in rows)


def lines(s):
    out = [l.rstrip() for l in s.replace('\r\n', '\n').split('\n')]
    while out and out[-1] == '':
        out.pop()
    return out


def main():
    problems = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    failures = []
    for p in problems:
        sql = p.get('sql')
        for i, t in enumerate(p['tests']):
            try:
                if sql:
                    got = run_sql(f"{sql['setup']}\n{t['input']}\n{p['reference']}")
                else:
                    got = run_python(p['reference'], t['input'])
            except Exception as err:  # noqa: BLE001 - reported as a failure
                failures.append({'key': p['key'], 'test': i, 'error': repr(err)})
                continue
            a, b = lines(got), lines(t['expectedOutput'])
            if sql and sql['orderInsensitive']:
                a, b = sorted(a), sorted(b)
            if a != b:
                failures.append({'key': p['key'], 'test': i, 'got': got[:300]})
    json.dump(failures, sys.stdout)


if __name__ == '__main__':
    main()
