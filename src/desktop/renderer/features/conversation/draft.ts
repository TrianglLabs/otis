/**
 * The draft to keep after a submission resolves. Acceptance consumes only the submitted text — anything typed
 * while admission was in flight is newer input and stays. Rejection always keeps the draft.
 */
export function draftAfterSend(current: string, submitted: string, accepted: boolean): string {
  return accepted && current === submitted ? "" : current
}
