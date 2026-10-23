import type { Instrumentation } from "next";

/**
 * Next.js calls this for every uncaught server error (Server Components, Route Handlers, Server
 * Actions, proxy). The route *pattern* is recorded, never the request path or headers, which can
 * carry ids, query strings and cookies.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { reportError } = await import("@/server/observability/errors");
  const digest =
    typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : null;
  await reportError(error, {
    source: context.routeType,
    route: context.routePath,
    digest,
  });
};
