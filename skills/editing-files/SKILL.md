---
name: editing-files
description: "Use when applying a patch or diff fails because line numbers shifted or context changed. Default to fuzzy methods; avoid Python string-replace snippets because of escaping/indentation pitfalls."
---

# Fuzzy patch application

Default to fuzzy patch tools. Do not use a Python `str.replace` snippet as the primary fix — embedding multi-line code blocks into Python strings is error-prone (indentation, backslashes, quotes, triple-quoted strings).

## Default workflow

### 1. Try `patch` with fuzz

```bash
patch --dry-run --fuzz=5 -p1 -i /path/to/changes.patch
```

- `--fuzz=N` (or `-F N`): allow up to `N` lines of context mismatch.
- Always `--dry-run` first to detect corruption.
- If clean, apply for real:
  ```bash
  patch --fuzz=5 -p1 -i /path/to/changes.patch
  ```

### 2. Fall back to `wiggle`

If `patch` rejects hunks, use `wiggle` instead of rewriting the patch by hand:

```bash
wiggle --replace file.orig file.rej
# or apply a whole patch
wiggle -p1 --replace < changes.patch
```

- `wiggle` inserts conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) instead of corrupting the file.
- Resolve markers, then verify with `git diff`.

### 3. Block search/replace only when fuzzy tools fail

If the patch is too mangled for `patch`/`wiggle`, use `perl` for a robust in-place search/replace:

```bash
perl -0777 -pi -e 's/^def helper\(x\):\n    return x \* 2$/def helper(x):\n    return x + 1/m' file.py
```

Rules for block search/replace:

- Search block must be unique (3–10 lines).
- Match indentation literally.
- Apply one logical change at a time.
- Verify with `git diff` and a syntax/test check.

## Anti-pattern

Avoid this:

```python
old = '''\
def helper(x):
    return x * 2
'''
new = '''\
def helper(x):
    return x + 1
'''
text = text.replace(old, new)
```

Why: escaping multi-line source through Python triple-quoted strings breaks indentation, backslashes, and nested quotes, leading to silent partial matches.

## Summary

1. `patch --dry-run --fuzz=5`
2. `wiggle --replace`
3. `perl -0777 -pi -e` block replace
4. Verify with `git diff` and tests.
