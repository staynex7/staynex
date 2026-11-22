/** Error that the central handler in server.js turns into a JSON response with this status. */
export function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
