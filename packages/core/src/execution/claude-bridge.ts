/**
 * Claude Bridge — Executes coding instructions via Anthropic Messages API.
 *
 * Instead of spawning Claude CLI (which requires local installation),
 * this calls the Anthropic API directly. Works in any environment.
 */

export interface ExecutionRequest {
  taskId: string;
  instruction: string;
  workDir: string;
  projectContext?: string; // repo name, recent files, etc.
  timeout?: number;
  allowedTools?: string[];
  blockedPatterns?: string[];
}

export interface ExecutionResult {
  taskId: string;
  status: "completed" | "failed" | "timeout";
  output: string;
  durationMs: number;
  exitCode: number | null;
  simulated: boolean;
}

const TASK_SYSTEM_PROMPT = `You are a senior software engineer working on a codebase. You receive coding instructions and produce high-quality code changes.

When given an instruction:
1. Analyze what needs to be done
2. Describe the changes you would make (files to create/modify, what to add/remove)
3. Write the actual code changes in a clear format
4. Explain any trade-offs or considerations

Be concise but thorough. Use code blocks with file paths. Focus on practical, production-ready code.`;

export class ClaudeBridge {
  private available: boolean = false;

  /** Check if the Anthropic API is available (API key is set). */
  async isAvailable(): Promise<boolean> {
    this.available = !!process.env.ANTHROPIC_API_KEY;
    return this.available;
  }

  /** Execute an instruction. Uses Anthropic API if key is set, otherwise simulates. */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return this.simulate(request);
    }

    const startTime = Date.now();
    const model = process.env.TASK_MODEL || "claude-sonnet-4-20250514";

    try {
      const userMessage = request.projectContext
        ? `Project: ${request.projectContext}\n\nInstruction: ${request.instruction}`
        : `Instruction: ${request.instruction}`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          system: TASK_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        }),
        signal: AbortSignal.timeout(request.timeout ?? 120000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return {
          taskId: request.taskId,
          status: "failed",
          output: `API error: ${res.status} ${errText.slice(0, 200)}`,
          durationMs: Date.now() - startTime,
          exitCode: null,
          simulated: false,
        };
      }

      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      const output = data.content?.[0]?.text || "(no output)";

      return {
        taskId: request.taskId,
        status: "completed",
        output: output.slice(0, 3000), // Limit output size
        durationMs: Date.now() - startTime,
        exitCode: 0,
        simulated: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return {
        taskId: request.taskId,
        status: message.includes("timeout") ? "timeout" : "failed",
        output: `Execution error: ${message}`,
        durationMs: Date.now() - startTime,
        exitCode: null,
        simulated: false,
      };
    }
  }

  private async simulate(request: ExecutionRequest): Promise<ExecutionResult> {
    const startTime = Date.now();
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    return {
      taskId: request.taskId,
      status: "completed",
      output: `[simulated] No ANTHROPIC_API_KEY. Would execute: "${request.instruction}"`,
      durationMs: Date.now() - startTime,
      exitCode: null,
      simulated: true,
    };
  }
}
