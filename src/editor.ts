/** Opens a directory in an editor; returns the launcher's exit code and stderr. */
export type EditorRunner = (dir: string) => Promise<{ code: number; stderr: string }>;

/** VS Code's `code` launcher. It hands off to the running VS Code and exits. */
export const vscodeRunner: EditorRunner = async (dir) => {
  let proc;
  try {
    proc = Bun.spawn(["code", dir], { stdout: "ignore", stderr: "pipe" });
  } catch (e) {
    return { code: 127, stderr: (e as Error).message };
  }
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
};
