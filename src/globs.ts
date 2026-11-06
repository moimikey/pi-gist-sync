// Minimal glob matcher for posix relative paths: `**`, `*`, `?`, `{a,b}`. No negation, no classes.

const cache = new Map<string, RegExp>();

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(ch: string): string {
  return ch.replace(REGEX_SPECIALS, "\\$&");
}

// Index of the `}` closing the `{` at `open`, or -1 so an unbalanced `{` stays literal.
function findClose(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function translate(glob: string): string {
  let i = 0;

  function seq(braceDepth: number): string {
    let out = "";
    while (i < glob.length) {
      const c = glob[i] as string;
      if (braceDepth > 0 && (c === "," || c === "}")) break;

      if (c === "\\" && i + 1 < glob.length) {
        out += escapeLiteral(glob[i + 1] as string);
        i += 2;
      } else if (c === "{" && findClose(glob, i) !== -1) {
        i++;
        const alts: string[] = [];
        for (;;) {
          alts.push(seq(braceDepth + 1));
          const sep = glob[i++];
          if (sep === "}") break;
        }
        out += `(?:${alts.join("|")})`;
      } else if (c === "*") {
        let end = i;
        while (glob[end] === "*") end++;
        const prev = glob[i - 1];
        const next = glob[end];
        const segStart = i === 0 || prev === "/" || prev === "{" || (prev === "," && braceDepth > 0);
        const segEnd = next === undefined || next === "/" || (braceDepth > 0 && (next === "," || next === "}"));
        if (end - i >= 2 && segStart && next === "/") {
          // `**/` spans zero or more whole directories
          out += "(?:.*/)?";
          i = end + 1;
          // Repeated `**/` is redundant and would make the regex backtrack badly
          while (glob.startsWith("**/", i)) i += 3;
        } else if (end - i >= 2 && segStart && segEnd) {
          out += ".*";
          i = end;
        } else {
          // `**` glued to other text behaves like `*`
          out += "[^/]*";
          i = end;
        }
      } else if (c === "?") {
        out += "[^/]";
        i++;
      } else {
        out += escapeLiteral(c);
        i++;
      }
    }
    return out;
  }

  return seq(0);
}

function compile(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    // `s` so `.*` also spans newlines in odd file names
    re = new RegExp(`^${translate(glob)}$`, "s");
    cache.set(glob, re);
  }
  return re;
}

export function matchGlob(glob: string, path: string): boolean {
  return compile(glob).test(path);
}

export function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((g) => matchGlob(g, path));
}
