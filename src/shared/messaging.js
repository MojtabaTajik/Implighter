// Every message type in one place. Features own their handlers, but the wire
// vocabulary is shared, so a rename can't silently desynchronise two slices.

export const MSG = {
  // highlight
  RUN: "implighter:run",
  CLEAR: "implighter:clear",
  STATE: "implighter:state",
  CLASSIFY: "implighter:classify",
  STATUS: "implighter:status",
  EXPORT_KEPT: "implighter:export-kept",

  // summarize — a long-running stream, so it uses a port rather than one-shot
  // request/response messaging.
  CAPABILITIES: "implighter:capabilities",     // popup -> content: what can this page do?
  SUMMARIZE_RUN: "implighter:summarize:run",   // popup -> content: open the modal
  SUMMARIZE_PORT: "implighter:summarize",      // content <-> worker: the stream
  SUMMARIZE_START: "implighter:summarize:start",

  // shared
  PING: "implighter:ping",   // is the content script loaded and listening?
  BADGE: "implighter:badge",
  VERIFY: "implighter:verify"
};

// Stream frames sent over the summarize port.
export const STREAM = {
  DELTA: "delta",
  DONE: "done",
  ERROR: "error"
};
