import { OrchError } from "./errors";

export type Platform = "gitlab" | "github";
export type ForgeBin = "gh" | "glab";
export type ForgeRunner = (
  bin: ForgeBin,
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs gh/glab. Request bodies go on stdin, never as a file path. */
export const forgeRunner: ForgeRunner = async (bin, args, stdin) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      env: process.env,
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "ENOENT") {
      throw new ForgeError(`${bin} is not installed (needed for /mr-review and /mr-fix)`);
    }
    throw e;
  }
  if (stdin !== undefined) {
    const sink = proc.stdin as import("bun").FileSink;
    sink.write(stdin);
    await sink.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export class ForgeError extends OrchError {
  /** HTTP status parsed from stderr when present. */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ForgeError";
    this.status = status;
  }
}

/** The concatenated top-level JSON values in `text` (glab --paginate prints one value per page). */
export function parseJsonStream(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    const start = i;
    if (text[i] === "{" || text[i] === "[") {
      let depth = 0;
      let inString = false;
      for (; i < text.length; i++) {
        const c = text[i];
        if (inString) {
          if (c === "\\") i++;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          if (--depth === 0) {
            i++;
            break;
          }
        }
      }
    } else if (text[i] === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      i++;
    } else {
      while (i < text.length && !/[\s\[{"]/.test(text[i])) i++;
    }
    values.push(JSON.parse(text.slice(start, i)));
  }
  return values;
}

function httpStatus(stderr: string): number | undefined {
  const m = stderr.match(/\bHTTP (\d{3})\b/) ?? stderr.match(/(?:^|[\s:])([1-5]\d\d)\s+[A-Z]/m);
  return m ? Number(m[1]) : undefined;
}

export class Forge {
  constructor(
    private run: ForgeRunner,
    private platform: Platform,
    private host: string,
  ) {}

  private get bin(): ForgeBin {
    return this.platform === "gitlab" ? "glab" : "gh";
  }

  /** `stdout` is the response body: glab and gh may print the API's error JSON there. */
  private fail(stderr: string, fallback: string, stdout = ""): ForgeError {
    const text = [stderr.trim() || fallback, stdout.trim()].filter(Boolean).join("\n");
    const status = httpStatus(stderr);
    if (status === 401 || /not logged|authentication|auth login/i.test(stderr)) {
      const login = this.platform === "gitlab" ? `glab auth login --hostname ${this.host}` : "gh auth login";
      return new ForgeError(`${text}\nNot logged in. Log in, then retry:\n! ${login}`, status);
    }
    return new ForgeError(text, status);
  }

  async rest(method: "GET" | "POST" | "PUT", path: string, body?: unknown, o: { paginate?: boolean } = {}): Promise<any> {
    const gl = this.platform === "gitlab";
    const args = [
      "api",
      ...(gl ? ["--hostname", this.host] : []),
      "--method",
      method,
      path,
      ...(o.paginate ? (gl ? ["--paginate"] : ["--paginate", "--slurp"]) : []),
      ...(body !== undefined ? ["--input", "-"] : []),
    ];
    const r = await this.run(this.bin, args, body !== undefined ? JSON.stringify(body) : undefined);
    // Exit code decides failure: snap glab warns on stderr on every call.
    if (r.code !== 0) throw this.fail(r.stderr, `${this.bin} exited ${r.code}`, r.stdout);
    if (!r.stdout.trim()) return o.paginate ? [] : null;
    let values: unknown[];
    try {
      values = parseJsonStream(r.stdout);
    } catch {
      throw new ForgeError(`${this.bin} api ${path}: unparseable response`);
    }
    if (!o.paginate) return values[0];
    // gh --slurp wraps all pages in one array; glab prints one array per page.
    const pages = gl ? values : ((values[0] as unknown[]) ?? []);
    return pages.flatMap((p) => (Array.isArray(p) ? p : [p]));
  }

  async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    if (this.platform !== "github") throw new ForgeError("graphql is only available on GitHub");
    const r = await this.run("gh", ["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
    let parsed: any;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      parsed = undefined;
    }
    // gh exits non-zero on GraphQL errors but still prints them on stdout.
    if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
      throw new ForgeError(parsed.errors.map((e: { message?: string }) => e.message ?? JSON.stringify(e)).join("; "));
    }
    if (r.code !== 0) throw this.fail(r.stderr, `gh exited ${r.code}`, r.stdout);
    if (parsed === undefined) throw new ForgeError("gh api graphql: unparseable response");
    return parsed.data;
  }
}
