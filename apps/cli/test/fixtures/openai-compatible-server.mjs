import http from "node:http";

const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};
    response.setHeader("Content-Type", "application/json");
    if (parsed.model === "failing-model") {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { message: "fixture upstream unavailable" } }));
      return;
    }
    if (request.url === "/v1/responses") {
      response.end(JSON.stringify({ output_text: "ok", model: parsed.model, usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    if (request.url === "/v1/chat/completions") {
      response.end(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], model: parsed.model, usage: { prompt_tokens: 1, completion_tokens: 1 } })
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: `Unexpected endpoint: ${request.url}` } }));
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") {
    process.stdout.write(`${address.port}\n`);
  }
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
