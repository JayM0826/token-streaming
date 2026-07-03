import type { ExecutionPlan, RepoManifest, RepoSummary } from "@token-streaming/protocol";
import type { VerificationResult } from "@token-streaming/protocol";
import type { RuntimeContextBundle } from "./context-builder.js";

export interface RuntimePrompt {
  system: string;
  user: string;
}

export function buildRuntimePrompt(input: {
  task: string;
  repo: RepoSummary;
  manifest: RepoManifest;
  plan: ExecutionPlan;
  context: RuntimeContextBundle;
}): RuntimePrompt {
  const wantsPatch = input.plan.phases.some((phase) => phase.id === "code-change");

  return {
    system: wantsPatch ? buildPatchSystemPrompt() : buildSummarySystemPrompt(),
    user: [
      `Task: ${input.task}`,
      "",
      input.context.overview,
      "",
      wantsPatch ? buildPatchInstructions() : buildSummaryInstructions()
    ].join("\n")
  };
}

export function buildRepairPrompt(input: {
  task: string;
  context: RuntimeContextBundle;
  verification: VerificationResult;
}): RuntimePrompt {
  return {
    system: buildPatchSystemPrompt(),
    user: [
      `Task: ${input.task}`,
      "",
      "The previous patch failed verification.",
      "",
      "## Verification Failure",
      `Command: ${input.verification.command}`,
      `Exit code: ${input.verification.exitCode ?? "unknown"}`,
      "Output:",
      "```text",
      input.verification.outputSummary,
      "```",
      "",
      input.context.overview,
      "",
      buildPatchInstructions()
    ].join("\n")
  };
}

function buildSummarySystemPrompt(): string {
  return [
    "You are Token Streaming's default orchestration runtime.",
    "Use the repository metadata before raw assumptions.",
    "Respect the role handoffs in the execution plan: each phase consumes the previous artifact and produces the next one.",
    "Return a concise engineering summary and next steps."
  ].join("\n");
}

function buildPatchSystemPrompt(): string {
  return [
    "You are Token Streaming's default code-change planner.",
    "Respect the role handoffs in the execution plan: research context informs coding, code output feeds verification, and verification feeds review.",
    "You must propose changes through a structured patch proposal.",
    "Do not claim that files were modified. The runtime applies patches after checkpointing."
  ].join("\n");
}

function buildSummaryInstructions(): string {
  return [
    "Return prose only.",
    "Cover what context matters, which modules or workflows are relevant, and what should happen next."
  ].join("\n");
}

function buildPatchInstructions(): string {
  return [
    "Return only a fenced JSON patch proposal using this exact shape:",
    "```json",
    "{",
    '  "summary": "Brief description of the proposed change.",',
    '  "files": [',
    "    {",
    '      "path": "relative/path/from/repo/root",',
    '      "content": "full replacement file content"',
    "    }",
    "  ]",
    "}",
    "```",
    "Rules:",
    "- Use full file contents, not diffs.",
    "- Keep paths relative to the repository root.",
    "- Do not include files unless their full content is known from the provided context.",
    "- If the change cannot be made safely from the available context, return an empty files array with a summary explaining what context is missing."
  ].join("\n");
}
