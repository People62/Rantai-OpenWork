/**
 * Why adding to the Library is blocked.
 *
 * Signing in and having an active organization are separate states, and
 * collapsing them into one message sends signed-in users to sign in again —
 * an instruction they have already followed, which can never clear the block.
 */
export type LibraryCreateBlockReason = "sign-in" | "choose-organization";

export function libraryCreateBlockReason(input: {
  authToken: string | null | undefined;
  activeOrgId: string | null | undefined;
}): LibraryCreateBlockReason | null {
  if (!input.authToken?.trim()) return "sign-in";
  if (!input.activeOrgId?.trim()) return "choose-organization";
  return null;
}
