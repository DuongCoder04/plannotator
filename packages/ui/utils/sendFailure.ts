/**
 * Why a decision POST (send feedback, approve, deny) did not land (#1392).
 *
 * The review pages used to swallow these failures: a POST to a server that
 * had stopped rejected with a network error, the catch only re-enabled the
 * button, and the reviewer could not tell that nothing reached the agent.
 * The handlers now tag the two real failure modes so the page can say which
 * one happened (`SendFailureToast`).
 */

export type SendFailure =
  /** fetch rejected: the server is gone (stopped, crashed) or unreachable. */
  | { kind: 'unreachable' }
  /** The server answered with a non-2xx status it has no dedicated UI for. */
  | { kind: 'rejected'; status: number }
  /** Anything else thrown before the response settled. */
  | { kind: 'unknown' };

export class DecisionSendError extends Error {
  readonly failure: SendFailure;
  constructor(failure: SendFailure, options?: { cause?: unknown }) {
    super(
      failure.kind === 'unreachable'
        ? 'Plannotator could not be reached'
        : failure.kind === 'rejected'
          ? `Plannotator answered ${failure.status}`
          : 'The decision was not sent',
      options,
    );
    this.name = 'DecisionSendError';
    this.failure = failure;
  }
}

/** `.catch()` for a decision fetch: a rejected fetch means the server is unreachable. */
export function throwUnreachable(cause: unknown): never {
  throw new DecisionSendError({ kind: 'unreachable' }, { cause });
}

/** Throws the `rejected` failure for a response that is not ok. */
export function assertSendOk(res: Response): void {
  if (!res.ok) throw new DecisionSendError({ kind: 'rejected', status: res.status });
}

export function sendFailureOf(error: unknown): SendFailure {
  return error instanceof DecisionSendError ? error.failure : { kind: 'unknown' };
}

/** The one sentence under the toast's title: why nothing reached the agent. */
export function describeSendFailure(failure: SendFailure): string {
  switch (failure.kind) {
    case 'unreachable':
      return "Plannotator isn't running or can't be reached.";
    case 'rejected':
      return `Plannotator answered with an error (${failure.status}).`;
    default:
      return 'Something went wrong before it was sent.';
  }
}
