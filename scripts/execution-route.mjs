import { HttpInputError, readJsonBody } from "./http-json.mjs";
import { executeCode } from "./code-runner.mjs";

export async function executionRoute(req, res) {
  if (
    req.method !== "POST" ||
    !req.headers["content-type"]?.startsWith("application/json")
  ) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "POST application/json required" }));
    return;
  }
  try {
    const result = await executeCode(
      await readJsonBody(req, 131072, "Execution request too large"),
    );
    res.writeHead(result.status === "unavailable" ? 503 : 200);
    res.end(JSON.stringify(result));
  } catch (error) {
    // Request and busy errors carry their status; anything else is internal.
    res.writeHead(error instanceof HttpInputError ? error.status : 500);
    res.end(JSON.stringify({ error: String(error) }));
  }
}
