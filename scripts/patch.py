import io

p = "api/main.py"
text = io.open(p, encoding="utf-8").read()

if "allow_origin_regex" in text:
    print("ALREADY PATCHED - nothing to do")
    raise SystemExit

lines = text.splitlines(keepends=True)
new_line = '    allow_origin_regex=r"https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?",\n'

out, i, patched = [], 0, False
while i < len(lines):
    if "allow_origins=[" in lines[i]:
        while i < len(lines) and "]," not in lines[i]:
            i += 1
        i += 1
        out.append(new_line)
        patched = True
        continue
    out.append(lines[i])
    i += 1

if patched:
    io.open(p, "w", encoding="utf-8", newline="").write("".join(out))
    print("PATCHED OK")
else:
    print("PATTERN NOT FOUND")