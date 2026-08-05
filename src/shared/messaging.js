// Every message type in one place. Features own their handlers, but the wire
// vocabulary is shared, so a rename can't silently desynchronise two slices.

export const MSG = {
  // highlight
  RUN: "implighter:run",
  CLEAR: "implighter:clear",
  STATE: "implighter:state",
  COLLAPSE: "implighter:collapse",
  CLASSIFY: "implighter:classify",
  STATUS: "implighter:status",

  // summarize — a long-running stream, so it uses a port rather than one-shot
  // request/response messaging.
  SUMMARIZE_RUN: "implighter:summarize:run",   // popup -> content: open the modal
  SUMMARIZE_PORT: "implighter:summarize",      // content <-> worker: the stream
  SUMMARIZE_START: "implighter:summarize:start",

  // shared
  BADGE: "implighter:badge",
  VERIFY: "implighter:verify"
};

// Stream frames sent over the summarize port.
export const STREAM = {
  DELTA: "delta",
  DONE: "done",
  ERROR: "error"
};
