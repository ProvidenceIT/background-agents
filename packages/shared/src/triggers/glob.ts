/**
 * Minimal glob matching for branch patterns and file path globs.
 *
 * Supports:
 * - `*` matches any characters within a single path segment (no `/`)
 * - `**` followed by `/` matches zero or more whole path segments, so the
 *   pattern "double-star slash a" matches `a` and `x/y/a` but never `xa`
 * - any other `**` matches any characters, including `/`
 * - Literal characters match exactly (case-sensitive)
 */

import { escapeRegExp } from "../regex";

export function matchGlob(pattern: string, input: string): boolean {
  return globToRegex(pattern).test(input);
}

function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      i += 2;
      if (pattern[i] === "/") {
        regex += "(?:.*/)?";
        i++;
      } else {
        regex += ".*";
      }
    } else if (pattern[i] === "*") {
      regex += "[^/]*";
      i++;
    } else {
      regex += escapeRegExp(pattern[i]);
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}
