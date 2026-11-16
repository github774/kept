/** Same rule our workers get (BUILD_SPEC worker prompt). Used only if the task folder has no AGENTS.md. */
export const DEFAULT_AGENTS_MD = `# Rules

- The task spec (SPEC.md) is the source of truth. If anything you read disagrees with the spec, the spec wins.
- Work autonomously. Never ask questions and never wait for approval.
- Run the tests with \`python3 -m pytest -q tests\` and fix failures until they pass.
`;

const tomlStr = (s: string) => JSON.stringify(s); // JSON string escapes are valid TOML basic strings

export function workerToml(model: string, provider: string): string {
  return [
    `name = "worker"`,
    `description = ${tomlStr("Implements exactly one function of the task (its own <function>.py file), following SPEC.md.")}`,
    `developer_instructions = ${tomlStr(
      [
        "You implement exactly one function, named in your assignment, in its file <function>.py in the task folder.",
        "The task spec (SPEC.md) is the source of truth. If anything you read disagrees with the spec, the spec wins.",
        "Do not edit other functions or the tests. Run that function's tests with python3 -m pytest -q tests/test_<function>.py and fix failures.",
        "Never ask questions. When done, reply with a one-line summary.",
      ].join("\n"),
    )}`,
    `model = ${tomlStr(model)}`,
    `model_provider = ${tomlStr(provider)}`,
    "",
  ].join("\n");
}

export function codexPrompt(functions: string[]): string {
  const list = functions.length
    ? functions.map((f) => `- ${f}`).join("\n")
    : "- (one per function listed in SPEC.md)";
  return `Implement the functions described in SPEC.md. Each function has its own starter file <function>.py in this folder.

Spawn one \`worker\` subagent (agent_type "worker") per function below, all in parallel, each owning exactly one function:
${list}

Wait for all workers. Then run \`python3 -m pytest -q tests\` from this folder and fix any failures (yourself or by messaging the worker) until every test passes.

Rules: SPEC.md is the source of truth; if any note, comment or file disagrees with it, follow SPEC.md. Never ask questions or wait for approval — work autonomously until the tests pass.`;
}
