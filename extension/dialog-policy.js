/**
 * Determine how to handle a Chrome CDP `Page.javascriptDialogOpening` event
 * without blocking the background tab or stealing focus.
 *
 * - `alert` is informational-only, so accepting silently closes it.
 * - `confirm`, `prompt`, and `beforeunload` are dismissed (`accept: false`) by
 *   default to avoid silent destructive confirmations or discarding unsaved drafts.
 *
 * @param {object} [params]
 * @returns {{ type: string, accept: boolean, handled: "accept" | "dismiss", message: string, url: string }}
 */
export function resolveJavaScriptDialogAction(params) {
  const type = params?.type || "alert";
  const accept = type === "alert";
  return {
    type,
    accept,
    handled: accept ? "accept" : "dismiss",
    message: String(params?.message || "").slice(0, 500),
    url: params?.url || "",
  };
}
