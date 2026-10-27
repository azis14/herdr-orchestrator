import { diffPosition, fileDiff, positionInDiff, type DiffPosition, type Side } from "./diffpos";
import { OrchError } from "./errors";
import { ForgeError, type Forge, type Platform } from "./forge";
import { encodeRepo, forgeFor, listThreads, type MrDeps, type MrInfo } from "./mr";

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

/** The `position` of a GitLab discussion. */
export interface GitlabPosition {
  position_type: "text";
  base_sha: string | null;
  start_sha: string | null;
  head_sha: string;
  old_path: string;
  new_path: string;
  old_line?: number;
  new_line?: number;
}

/** Where a GitHub review thread is anchored. */
export interface GithubAnchor {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
}

export interface DryRun {
  summary: string;
  /** `payload`: what would anchor the comment on the platform. */
  comments: { path: string; line: number; position: DiffPosition; body: string; payload: GitlabPosition | GithubAnchor }[];
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

const NOTHING_POSTED = "nothing was posted";

/**
 * `e` saying "nothing was posted", for an error raised before anything was sent: the caller may fix the cause
 * and post again. OutsideError (exit 3) and errors already saying so pass through unchanged.
 */
export function nothingPosted(e: unknown): unknown {
  if (!(e instanceof OrchError) || e instanceof OutsideError || e.message.includes(NOTHING_POSTED)) return e;
  return new OrchError(`${e.message}${e.message.includes("\n") ? "\n" : "; "}${NOTHING_POSTED}`);
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

const query = (c: ReviewComment, line = c.line, side: Side = c.side ?? "new") => ({ path: c.path, oldPath: c.oldPath || c.path, line, side });

/** Every comment's position; throws OutsideError (nothing posted) if any line, or any line a suggestion replaces, is outside the diff. */
async function validate(deps: MrDeps, mr: MrInfo, input: ReviewInput): Promise<Placed[]> {
  const base = mr.base;
  if (!base) throw new OrchError(`no base commit for ${mr.kind} ${mr.number}`);
  for (const c of input.comments) {
    if (c.suggestion && c.side === "old") throw new OrchError(`${c.path}:${c.line}: a suggestion can't go on a removed line (side old)`);
  }
  // One `git diff` per file; every line (and every line a suggestion replaces) is looked up in it.
  const diffs = new Map<string, Promise<string>>();
  const diffOf = (c: ReviewComment) => {
    const key = JSON.stringify([c.oldPath || c.path, c.path]);
    if (!diffs.has(key)) diffs.set(key, fileDiff(deps.git, mr.projectPath, base, mr.head, c));
    return diffs.get(key)!;
  };
  const placed: Placed[] = [];
  const outside: ReviewComment[] = [];
  for (const c of input.comments) {
    const diff = await diffOf(c);
    const pos = positionInDiff(diff, query(c));
    let fits = pos.kind !== "outside";
    if (fits && c.suggestion) {
      const { above = 0, below = 0 } = c.suggestion;
      if (c.line - above < 1) fits = false;
      for (let l = c.line - above; fits && l <= c.line + below; l++) {
        if (l === c.line) continue;
        const k = positionInDiff(diff, query(c, l, "new")).kind;
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
  let review: ReviewInput;
  let placed: Placed[];
  try {
    review = checkReviewInput(input);
    placed = await validate(deps, mr, review);
  } catch (e) {
    throw nothingPosted(e);
  }
  if (o.dryRun) {
    return {
      summary: review.summary,
      comments: placed.map(({ c, pos }) => ({
        path: c.path,
        line: c.line,
        position: pos,
        body: renderBody(mr.platform, c),
        payload: mr.platform === "gitlab" ? gitlabPosition(mr, pos) : githubAnchor(c, pos),
      })),
    };
  }
  const forge = forgeFor(deps, mr);
  return mr.platform === "gitlab" ? postGitlab(deps, forge, mr, review, placed) : postGithub(forge, mr, review, placed);
}

function gitlabPosition(mr: MrInfo, pos: DiffPosition): GitlabPosition {
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
  if (!mr.start) throw new OrchError(`no start commit (diff_refs.start_sha) for mr ${mr.number}; ${NOTHING_POSTED}`);
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
        // Recheck the position once (a fresh diff) and retry; a second rejection fails the comment.
        const again = await diffPosition(deps.git, mr.projectPath, mr.base as string, mr.head, query(c));
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
  addPullRequestReview(input: $input) { pullRequestReview { id url } }
}`;

const ADD_THREAD = `mutation AddThread($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { id comments(first: 1) { nodes { url } } } }
}`;

const SUBMIT_REVIEW = `mutation SubmitReview($input: SubmitPullRequestReviewInput!) {
  submitPullRequestReview(input: $input) { pullRequestReview { id url } }
}`;

/** Where a GitHub thread goes: LEFT only for a removed line; a multi-line suggestion spans startLine..line. */
function githubAnchor(c: ReviewComment, pos: DiffPosition): GithubAnchor {
  const removed = pos.kind === "removed";
  const side = removed ? "LEFT" : "RIGHT";
  const line = (removed ? pos.oldLine : pos.line) as number;
  const { above = 0, below = 0 } = c.suggestion ?? {};
  return {
    path: pos.path,
    line: line + below,
    side,
    ...(above + below > 0 ? { startLine: line - above, startSide: side } : {}),
  };
}

async function postGithub(forge: Forge, mr: MrInfo, input: ReviewInput, placed: Placed[]): Promise<PostResult> {
  if (!mr.nodeId) throw new OrchError(`no node id for pr ${mr.number}; ${NOTHING_POSTED}`);
  let reviewId: string;
  let reviewUrl: string;
  try {
    const data = await forge.graphql(ADD_REVIEW, { input: { pullRequestId: mr.nodeId, commitOID: mr.head } });
    const created = data?.addPullRequestReview?.pullRequestReview;
    if (!created?.id) throw new ForgeError("addPullRequestReview returned no review id");
    reviewId = created.id;
    reviewUrl = created.url ?? mr.url;
  } catch (e) {
    if (e instanceof OrchError && /pending review/i.test(e.message)) {
      throw new OrchError(`you already have a pending review on pr ${mr.number} (${e.message}); submit or discard it on ${mr.url}, then post again; ${NOTHING_POSTED}`);
    }
    // The call may have reached GitHub before failing (or answered without an id).
    const why = e instanceof Error ? e.message : String(e);
    throw new OrchError(`starting the review on pr ${mr.number} failed: ${why}\na review may have been created and left pending; check ${mr.url} and submit or discard it`);
  }

  // From here on a pending review exists: nothing may escape without saying so.
  const results: CommentResult[] = [];
  let next = 0; // index of the comment being (or next to be) attempted
  try {
    const failed: ReviewComment[] = [];
    for (; next < placed.length; next++) {
      const { c, pos } = placed[next];
      try {
        const data = await forge.graphql(ADD_THREAD, { input: { pullRequestReviewId: reviewId, ...githubAnchor(c, pos), body: renderBody("github", c) } });
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
    const data = await forge.graphql(SUBMIT_REVIEW, { input: { pullRequestReviewId: reviewId, event: "COMMENT", body: appendUnposted(input.summary, failed) } });
    return { comments: results, summaryUrl: data?.submitPullRequestReview?.pullRequestReview?.url ?? null };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const where = (p: Placed) => `${p.c.path}:${p.c.line}`;
    const lines = [
      `review ${reviewId} on pr ${mr.number} was not submitted: ${why}`,
      `It is still pending on ${reviewUrl}; submit or discard it there.`,
      `Comments:\n${describeResults(results) || "(none posted)"}`,
    ];
    if (next < placed.length) {
      lines.push(`interrupted (outcome unknown): ${where(placed[next])}`);
      if (next + 1 < placed.length) lines.push(`not attempted: ${placed.slice(next + 1).map(where).join(", ")}`);
    }
    throw new OrchError(lines.join("\n"));
  }
}

/** `body` as is, or an OrchError if it is blank. */
export function checkBody(body: string): string {
  if (!body.trim()) throw new OrchError("the body is empty; pipe the text on stdin");
  return body;
}

const mrApi = (mr: MrInfo) => `projects/${encodeRepo(mr.repo)}/merge_requests/${mr.number}`;
const gitlabNoteUrl = (mr: MrInfo, note: any) => (note?.id != null ? `${mr.url}#note_${note.id}` : mr.url);

/** Refuses an id that isn't a review thread of this MR (a general note, or another MR's thread). */
async function requireThread(deps: MrDeps, mr: MrInfo, threadId: string): Promise<void> {
  const { threads } = await listThreads(deps, mr);
  if (!threads.some((t) => t.id === threadId)) throw new OrchError(`${threadId} is not a review thread on ${mr.kind} ${mr.number}`);
}

/** Posts a general note (comment) on the MR/PR; returns its url. */
export async function postNote(deps: MrDeps, mr: MrInfo, body: string): Promise<string> {
  checkBody(body);
  const forge = forgeFor(deps, mr);
  if (mr.platform === "gitlab") {
    const note: any = await forge.rest("POST", `${mrApi(mr)}/notes`, { body });
    return gitlabNoteUrl(mr, note);
  }
  const comment: any = await forge.rest("POST", `repos/${mr.repo}/issues/${mr.number}/comments`, { body });
  return comment?.html_url ?? mr.url;
}

const REPLY_THREAD = `mutation ReplyThread($input: AddPullRequestReviewThreadReplyInput!) {
  addPullRequestReviewThreadReply(input: $input) { comment { id url } }
}`;

const RESOLVE_THREAD = `mutation ResolveThread($input: ResolveReviewThreadInput!) {
  resolveReviewThread(input: $input) { thread { id isResolved } }
}`;

/** Replies in an existing review thread; returns the reply's url. */
export async function replyThread(deps: MrDeps, mr: MrInfo, threadId: string, body: string): Promise<string> {
  checkBody(body);
  await requireThread(deps, mr, threadId);
  const forge = forgeFor(deps, mr);
  if (mr.platform === "gitlab") {
    const note: any = await forge.rest("POST", `${mrApi(mr)}/discussions/${encodeURIComponent(threadId)}/notes`, { body });
    return gitlabNoteUrl(mr, note);
  }
  const data = await forge.graphql(REPLY_THREAD, { input: { pullRequestReviewThreadId: threadId, body } });
  return data?.addPullRequestReviewThreadReply?.comment?.url ?? mr.url;
}

/** Resolves a review thread (only the one asked for); returns the thread's resolved state. */
export async function resolveThread(deps: MrDeps, mr: MrInfo, threadId: string): Promise<boolean> {
  await requireThread(deps, mr, threadId);
  const forge = forgeFor(deps, mr);
  if (mr.platform === "gitlab") {
    const d: any = await forge.rest("PUT", `${mrApi(mr)}/discussions/${encodeURIComponent(threadId)}?resolved=true`);
    return !!d?.notes?.[0]?.resolved;
  }
  const data = await forge.graphql(RESOLVE_THREAD, { input: { threadId } });
  return !!data?.resolveReviewThread?.thread?.isResolved;
}

/** Plain-text output of `orch mr post`. */
export function formatPost(r: PostResult | DryRun): string {
  if ("summaryUrl" in r) return [describeResults(r.comments), `summary ${r.summaryUrl ?? "(no url)"}`].filter(Boolean).join("\n");
  const comments = r.comments.map((c) => `--- ${c.path}:${c.line} (${c.position.kind}) ${JSON.stringify(c.payload)}\n${c.body}`);
  return [...comments, `--- summary\n${r.summary}`, "(dry run: nothing posted)"].join("\n\n");
}
