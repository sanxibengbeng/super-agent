/**
 * Attempts to repair malformed JSON strings — specifically handles:
 * 1. Unescaped control characters (newlines, tabs) inside string values
 * 2. Unescaped quotes inside string values
 *
 * Strategy: parse character-by-character, tracking whether we're inside a JSON
 * string. When we hit a `"` inside a string that doesn't look like a proper
 * string-close (next non-whitespace isn't `,`, `}`, `]`, or `:` for keys),
 * escape it. When we hit a raw newline inside a string, replace with `\n`.
 */
export function repairJson(raw: string): string {
  const out: string[] = [];
  let i = 0;
  const len = raw.length;
  let inString = false;

  while (i < len) {
    const ch = raw.charAt(i);

    if (!inString) {
      if (ch === '"') inString = true;
      out.push(ch);
      i++;
      continue;
    }

    // Inside a string value
    if (ch === '\\') {
      out.push(ch);
      i++;
      if (i < len) { out.push(raw.charAt(i)); i++; }
      continue;
    }

    if (ch === '"') {
      if (isStringClose(raw, i)) {
        inString = false;
        out.push(ch);
      } else {
        out.push('\\"');
      }
      i++;
      continue;
    }

    // Raw control characters inside string
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (ch === '\n') { out.push('\\n'); }
      else if (ch === '\r') { out.push('\\r'); }
      else if (ch === '\t') { out.push('\\t'); }
      else { out.push('\\u' + code.toString(16).padStart(4, '0')); }
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join('');
}

function isStringClose(raw: string, pos: number): boolean {
  let j = pos + 1;
  const len = raw.length;

  while (j < len && (raw.charAt(j) === ' ' || raw.charAt(j) === '\t' || raw.charAt(j) === '\n' || raw.charAt(j) === '\r')) {
    j++;
  }

  if (j >= len) return true;

  const next = raw.charAt(j);
  return next === ',' || next === '}' || next === ']' || next === ':';
}

/**
 * Attempt JSON.parse, falling back to repair + parse.
 * Returns null if both attempts fail.
 */
export function safeParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(repairJson(raw));
    } catch {
      return null;
    }
  }
}
