/** A stable facet id: 1 to 100 letters, digits, `_`, `-` or `.`. The app
 * refuses a scope definition with any other id (learner ledger keys), so the
 * relay checks it too and a reply is corrected inside the same call. */
export const FACET_ID = /^[-\w.]{1,100}$/;
