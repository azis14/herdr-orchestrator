import { diffPosition, type DiffPosition, type Side } from "./diffpos";
import { OrchError } from "./errors";
import { ForgeError, type Forge, type Platform } from "./forge";
import { encodeRepo, forgeFor, type MrDeps, type MrInfo } from "./mr";

/** Replacement lines: the commented line plus `above` lines before it and `below` after it. */
export interface Suggestion {
  text: string;
  above?: number;
  below?: number;
}

export interface ReviewComment {
  path: string;
  oldPath?: string;
  line: number;
  side?: Side;
  body: string;
  suggestion?: Suggestion;
}

export interface ReviewInput {
  summary: string;
  comments: ReviewComment[];
}

export interface CommentResult {
  path: string;
  line: number;
  status: "placed" | "unplaced" | "failed";
  url?: string;
  error?: string;
}

export interface PostResult {
  comments: CommentResult[];
  summaryUrl: string | null;
}

export interface DryRun {
  summary: string;
  comments: { path: string; line: number; position: DiffPosition; body: string }[];
}

/** Thrown before anything is posted when some comments can't be placed; the CLI prints them as JSON and exits 3. */
export class OutsideError extends OrchError {
  outside: ReviewComment[];
  constructor(outside: ReviewComment[]) {
    super(`not on a changed line, nothing posted: ${outside.map((c) => `${c.path}:${c.line}`).join(", ")}`);
    this.name = "OutsideError";
    this.outside = outside;
  }
}

const isInt = (n: unknown, min: number) => Number.isInteger(n) && (n as number) >= min;

/** `raw` as a ReviewInput, or an OrchError naming the first bad field. */
export function checkReviewInput(raw: unknown): ReviewInput {
  const r = raw as Partial<ReviewInput> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new OrchError('review input must be a JSON object {"summary", "comments"}');
  if (typeof r.summary !== "string" || !r.summary.trim()) throw new OrchError('review input needs a non-empty "summary"');
  const comments = r.comments ?? [];
  if (!Array.isArray(comments)) throw new OrchError('review input "comments" must be an array');
  comments.forEach((c, i) => {
    const bad = (what: string) => new OrchError(`comments[${i}] needs ${what}`);
    if (!c || typeof c !== "object") throw bad("to be an object");
    if (typeof c.path !== "string" || !c.path) throw bad('"path"');
    if (c.oldPath !== undefined && typeof c.oldPath !== "string") throw bad('"oldPath" to be a string');
    if (!isInt(c.line, 1)) throw bad('"line" (a positive integer)');
    if (c.side !== undefined && c.side !== "new" && c.side !== "old") throw bad('"side" to be new or old');
    if (typeof c.body !== "string" || !c.body.trim()) throw bad('a non-empty "body"');
    const s = c.suggestion;
    if (s !== undefined) {
      if (!s || typeof s !== "object" || typeof s.text !== "string") throw bad('"suggestion.text"');
      if (s.above !== undefined && !isInt(s.above, 0)) throw bad('"suggestion.above" to be a non-negative integer');
      if (s.below !== undefined && !isInt(s.below, 0)) throw bad('"suggestion.below" to be a non-negative integer');
    }
  });
  return { summary: r.summary, comments };
}

/** The review JSON piped to `orch mr post`. */
export function parseReviewInput(text: string): ReviewInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OrchError('mr post reads the review as JSON on stdin ({"summary", "comments"}); stdin was not valid JSON');
  }
  return checkReviewInput(raw);
}

/** The comment body, then its suggestion fenced in the platform's syntax (GitHub's range is set by startLine/line instead). */
export function renderBody(platform: Platform, c: ReviewComment): string {
  if (!c.suggestion) return c.body;
  const { text, above = 0, below = 0 } = c.suggestion;
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((s) => s.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const info = platform === "gitlab" ? `suggestion:-${above}+${below}` : "suggestion";
  // Empty text deletes the lines; otherwise one trailing newline is the fence's, not a blank line.
  const inner = text === "" ? "" : `${text.replace(/\n$/, "")}\n`;
  return `${c.body.trimEnd()}\n\n${fence}${info}\n${inner}${fence}`;
}

const UNPOSTED_HEADING = "**Not on a changed line**";
const isUnpostedHeading = (l: string) => /^\s*(#{1,6}\s+)?(\*\*)?Not on a changed line(\*\*)?:?\s*$/i.test(l);
const isListLine = (l: string) => /^\s*([-*+]|\d+[.)])\s/.test(l) || /^\s+\S/.test(l);

/** `summary` with each failed comment listed under "Not on a changed line" (the heading is added at the end if absent). */
export function appendUnposted(summary: string, failed: ReviewComment[]): string {
  if (failed.length === 0) return summary;
  const items = failed.map((c) => `- \`${c.path}:${c.line}\` — ${c.body.split("\n").find((l) => l.trim())?.trim() ?? ""}`);
  const lines = summary.split("\n");
  const h = lines.findIndex(isUnpostedHeading);
  if (h < 0) return `${summary.trimEnd()}\n\n${UNPOSTED_HEADING}\n\n${items.join("\n")}`;
  let i = h + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && isListLine(lines[i])) {
    while (i < lines.length && isListLine(lines[i])) i++;
    lines.splice(i, 0, ...items);
  } else {
    lines.splice(h + 1, 0, "", ...items);
  }
  return lines.join("\n");
}

interface Placed {
  c: ReviewComment;
  pos: DiffPosition;
}

function place(deps: MrDeps, mr: MrInfo & { base: string }, c: ReviewComment, line = c.line, side: Side = c.side ?? "new"): Promise<DiffPosition> {
  return diffPosition(deps.git, mr.projectPath, mr.base, mr.head, { path: c.path, oldPath: c.oldPath, line, side });
}

/** Every comment's position; throws OutsideError (nothing posted) if any line, or any line a suggestion replaces, is outside the diff. */
async function validate(deps: MrDeps, mr: MrInfo, input: ReviewInput): Promise<Placed[]> {
  if (!mr.base) throw new OrchError(`no base commit for ${mr.kind} ${mr.number}`);
  const withBase = mr as MrInfo & { base: string };
  for (const c of input.comments) {
    if (c.suggestion && c.side === "old") throw new OrchError(`${c.path}:${c.line}: a suggestion can't go on a removed line (side old)`);
  }
  const placed: Placed[] = [];
  const outside: ReviewComment[] = [];
  for (const c of input.comments) {
    const pos = await place(deps, withBase, c);
    let fits = pos.kind !== "outside";
    if (fits && c.suggestion) {
      const { above = 0, below = 0 } = c.suggestion;
      if (c.line - above < 1) fits = false;
      for (let l = c.line - above; fits && l <= c.line + below; l++) {
        if (l === c.line) continue;
        const k = (await place(deps, withBase, c, l, "new")).kind;
        fits = k === "added" || k === "context";
      }
    }
    if (fits) placed.push({ c, pos });
    else outside.push(c);
  }
  if (outside.length > 0) throw new OutsideError(outside);
  return placed;
}

/** One line per comment result, for error messages that must not lose what was already posted. */
const describeResults = (results: CommentResult[]): string =>
  results.map((r) => `${r.status} ${r.path}:${r.line}${r.url ? ` ${r.url}` : ""}${r.error ? `: ${r.error}` : ""}`).join("\n");

const failure = (c: ReviewComment, error: string): CommentResult => ({ path: c.path, line: c.line, status: "failed", error });

/** Posts the review: one inline thread per comment, then the summary (with any failed comment listed in it). Validates first. */
export async function postReview(deps: MrDeps, mr: MrInfo, input: ReviewInput, o: { dryRun?: boolean } = {}): Promise<PostResult | DryRun> {
  checkReviewInput(input);
  const placed = await validate(deps, mr, input);
  if (o.dryRun) {
    return {
      summary: input.summary,
      comments: placed.map(({ c, pos }) => ({ path: c.path, line: c.line, position: pos, body: renderBody(mr.platform, c) })),
    };
  }
  const forge = forgeFor(deps, mr);
  return mr.platform === "gitlab" ? postGitlab(deps, forge, mr, input, placed) : postGithub(forge, mr, input, placed);
}

function gitlabPosition(mr: MrInfo, pos: DiffPosition) {
  return {
    position_type: "text",
    base_sha: mr.base,
    start_sha: mr.start,
    head_sha: mr.head,
    old_path: pos.oldPath,
    new_path: pos.path,
    ...(pos.kind !== "added" ? { old_line: pos.oldLine } : {}),
    ...(pos.kind !== "removed" ? { new_line: pos.line } : {}),
  };
}

const rejectedPosition = (e: unknown) => e instanceof ForgeError && (e.status === 400 || e.status === 422);

async function postGitlab(deps: MrDeps, forge: Forge, mr: MrInfo, input: ReviewInput, placed: Placed[]): Promise<PostResult> {
  if (!mr.start) throw new OrchError(`no start commit (diff_refs.start_sha) for mr ${mr.number}`);
  const mrPath = `projects/${encodeRepo(mr.repo)}/merge_requests/${mr.number}`;
  const results: CommentResult[] = [];
  const failed: ReviewComment[] = [];

  for (const { c, pos } of placed) {
    const body = renderBody("gitlab", c);
    const send = (p: DiffPosition) => forge.rest("POST", `${mrPath}/discussions`, { body, position: gitlabPosition(mr, p) });
    let d: any;
    try {
      try {
        d = await send(pos);
      } catch (e) {
        if (!rejectedPosition(e)) throw e;
        // Recheck the position once and retry; a second rejection fails the comment.
        const again = await place(deps, mr as MrInfo & { base: string }, c);
        if (again.kind === "outside") throw new OrchError(`${(e as Error).message}\n(rechecked: no longer on a changed line)`);
        d = await send(again);
      }
    } catch (e) {
      if (!(e instanceof OrchError)) throw e;
      failed.push(c);
      results.push(failure(c, e.message));
      continue;
    }
    const note = d?.notes?.[0];
    // A note without a position exists only as a general comment: report it, never re-post it.
    results.push({ path: c.path, line: c.line, status: note?.position ? "placed" : "unplaced", ...(note?.id != null ? { url: `${mr.url}#note_${note.id}` } : {}) });
  }

  let note: any;
  try {
    note = await forge.rest("POST", `${mrPath}/notes`, { body: appendUnposted(input.summary, failed) });
  } catch (e) {
    if (!(e instanceof OrchError)) throw e;
    throw new OrchError(`posting the summary note on mr ${mr.number} failed: ${e.message}\nComments:\n${describeResults(results)}`);
  }
  return { comments: results, summaryUrl: note?.id != null ? `${mr.url}#note_${note.id}` : null };
}

const ADD_REVIEW = `mutation AddReview($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) { pullRequestReview { id } }
}`;

const ADD_THREAD = `mutation AddThread($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { id comments(first: 1) { nodes { url } } } }
}`;

const SUBMIT_REVIEW = `mutation SubmitReview($input: SubmitPullRequestReviewInput!) {
  submitPullRequestReview(input: $input) { pullRequestReview { id url } }
}`;

function githubThread(reviewId: string, c: ReviewComment, pos: DiffPosition) {
  const removed = pos.kind === "removed";
  const side = removed ? "LEFT" : "RIGHT";
  const line = (removed ? pos.oldLine : pos.line) as number;
  const { above = 0, below = 0 } = c.suggestion ?? {};
  return {
    pullRequestReviewId: reviewId,
    path: pos.path,
    line: line + below,
    side,
    // A multi-line suggestion replaces startLine..line.
    ...(above + below > 0 ? { startLine: line - above, startSide: side } : {}),
    body: renderBody("github", c),
  };
}

async function postGithub(forge: Forge, mr: MrInfo, input: ReviewInput, placed: Placed[]): Promise<PostResult> {
  if (!mr.nodeId) throw new OrchError(`no node id for pr ${mr.number}`);
  let reviewId: string;
  try {
    const data = await forge.graphql(ADD_REVIEW, { input: { pullRequestId: mr.nodeId, commitOID: mr.head } });
    reviewId = data?.addPullRequestReview?.pullRequestReview?.id;
    if (!reviewId) throw new ForgeError("addPullRequestReview returned no review id");
  } catch (e) {
    if (e instanceof OrchError && /pending review/i.test(e.message)) {
      throw new OrchError(`you already have a pending review on pr ${mr.number} (${e.message}); submit or discard it on ${mr.url}, then post again`);
    }
    throw e;
  }

  const results: CommentResult[] = [];
  const failed: ReviewComment[] = [];
  for (const { c, pos } of placed) {
    try {
      const data = await forge.graphql(ADD_THREAD, { input: githubThread(reviewId, c, pos) });
      const thread = data?.addPullRequestReviewThread?.thread;
      if (!thread) throw new ForgeError("GitHub created no thread for this line");
      const url = thread.comments?.nodes?.[0]?.url;
      results.push({ path: c.path, line: c.line, status: "placed", ...(url ? { url } : {}) });
    } catch (e) {
      if (!(e instanceof OrchError)) throw e;
      failed.push(c);
      results.push(failure(c, e.message));
    }
  }

  let review: any;
  try {
    const data = await forge.graphql(SUBMIT_REVIEW, { input: { pullRequestReviewId: reviewId, event: "COMMENT", body: appendUnposted(input.summary, failed) } });
    review = data?.submitPullRequestReview?.pullRequestReview;
  } catch (e) {
    if (!(e instanceof OrchError)) throw e;
    throw new OrchError(
      `the review on pr ${mr.number} was built but not submitted: ${e.message}\nIt is still pending on ${mr.url}; submit or discard it there.\nComments:\n${describeResults(results)}`,
    );
  }
  return { comments: results, summaryUrl: review?.url ?? null };
}

/** Plain-text output of `orch mr post`. */
export function formatPost(r: PostResult | DryRun): string {
  if ("summaryUrl" in r) return [describeResults(r.comments), `summary ${r.summaryUrl ?? "(no url)"}`].filter(Boolean).join("\n");
  const comments = r.comments.map((c) => `--- ${c.path}:${c.line} (${c.position.kind})\n${c.body}`);
  return [...comments, `--- summary\n${r.summary}`, "(dry run: nothing posted)"].join("\n\n");
}
