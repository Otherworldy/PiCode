/** 身份隔离 key。Pi cwd 仍用 workspacePath。 */
export function workspaceKey(workspaceIdentity?: string | null, workspacePath?: string | null): string {
  const identity = workspaceIdentity?.trim();
  if (identity) return identity;
  const path = workspacePath?.trim();
  if (path) return path;
  throw new Error("pi-host requires workspaceIdentity or workspacePath");
}
