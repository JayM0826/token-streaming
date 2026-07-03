import type { ModelProvider, ModelRequest, ModelResponse } from "@token-streaming/protocol";

export class StubModelProvider implements ModelProvider {
  readonly name = "stub";

  async generate(input: ModelRequest): Promise<ModelResponse> {
    const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const taskLine = lastUserMessage
      .split(/\r?\n/)
      .find((line) => line.startsWith("Task:"))
      ?.replace(/^Task:\s*/, "");
    return {
      model: this.name,
      provider: this.name,
      content: [
        "Stub provider response.",
        "",
        "A real model provider can replace this class without changing the core runtime.",
        "",
        `Task: ${taskLine ?? "not provided"}`,
        `Prompt size: ${lastUserMessage.length} characters.`
      ].join("\n")
    };
  }
}
