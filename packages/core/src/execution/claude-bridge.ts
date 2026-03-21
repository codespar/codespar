/**
 * Claude Bridge — Executes coding instructions via Anthropic Messages API.
 *
 * Instead of spawning Claude CLI (which requires local installation),
 * this calls the Anthropic API directly. Works in any environment.
 *
 * When a linked repo is available, `executeWithRepo()` reads the actual
 * codebase via GitHub API, sends existing code as context to Claude,
 * then commits changes and opens a PR — all through the GitHub REST API.
 */

import { GitHubClient } from "../github/index.js";

export interface ExecutionRequest {
  taskId: string;
  instruction: string;
  workDir: string;
  projectContext?: string; // repo name, recent files, etc.
  timeout?: number;
  allowedTools?: string[];
  blockedPatterns?: string[];
  /** Image URLs to include as visual context (screenshots, diagrams) */
  imageUrls?: Array<{ url: string; mimeType?: string }>;
}

export interface RepoExecutionRequest extends ExecutionRequest {
  repoOwner: string;
  repoName: string;
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
      const userText = request.projectContext
        ? `Project: ${request.projectContext}\n\nInstruction: ${request.instruction}`
        : `Instruction: ${request.instruction}`;

      // Build message content with images if present
      const userContent = await this.buildUserContent(userText, request.imageUrls);

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
          messages: [{ role: "user", content: userContent }],
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

  /** Execute an instruction with streaming. Calls onChunk for each text delta. */
  async executeStreaming(
    request: ExecutionRequest,
    onChunk: (text: string) => void,
  ): Promise<ExecutionResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return this.simulate(request);
    }

    const startTime = Date.now();
    const model = process.env.TASK_MODEL || "claude-sonnet-4-20250514";

    try {
      const userText = request.projectContext
        ? `Project: ${request.projectContext}\n\nInstruction: ${request.instruction}`
        : `Instruction: ${request.instruction}`;

      // Build message content with images if present
      const userContent = await this.buildUserContent(userText, request.imageUrls);

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
          stream: true,
          system: TASK_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
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

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let fullOutput = "";
      let buffer = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const event = JSON.parse(data);
              if (event.type === "content_block_delta" && event.delta?.text) {
                fullOutput += event.delta.text;
                onChunk(event.delta.text);
              }
            } catch {
              /* skip malformed JSON */
            }
          }
        }
      }

      return {
        taskId: request.taskId,
        status: "completed",
        output: fullOutput.slice(0, 3000),
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

  /**
   * Build the user message content for the Claude API.
   * If image URLs are provided, downloads and base64-encodes them
   * into image content blocks alongside the text instruction.
   */
  private async buildUserContent(
    text: string,
    imageUrls?: Array<{ url: string; mimeType?: string }>,
  ): Promise<string | Array<Record<string, unknown>>> {
    if (!imageUrls || imageUrls.length === 0) {
      return text;
    }

    const contentParts: Array<Record<string, unknown>> = [];

    for (const img of imageUrls) {
      try {
        // Slack file URLs require bot token authentication
        const headers: Record<string, string> = {};
        if (img.url.includes("slack")) {
          const slackToken = process.env.SLACK_BOT_TOKEN;
          if (slackToken) {
            headers["Authorization"] = `Bearer ${slackToken}`;
          }
        }

        const imgRes = await fetch(img.url, { headers });
        if (imgRes.ok) {
          const buffer = await imgRes.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const mediaType =
            img.mimeType ||
            imgRes.headers.get("content-type") ||
            "image/png";
          contentParts.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64,
            },
          });
        }
      } catch {
        // Skip failed image downloads silently
      }
    }

    // Always include the text instruction
    contentParts.push({ type: "text", text });

    // If no images were successfully downloaded, return plain text
    return contentParts.length > 1 ? contentParts : text;
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

  /**
   * Execute an instruction against a real GitHub repository.
   *
   * Flow:
   * 1. Search the repo for files relevant to the instruction
   * 2. Read their contents
   * 3. Send existing code + instruction to Claude with full context
   * 4. Parse Claude's output for file changes
   * 5. Create a branch, commit changes, and open a PR
   * 6. Return PR URL
   *
   * Falls back to generic `execute()` if GITHUB_TOKEN is not set.
   */
  async executeWithRepo(request: RepoExecutionRequest): Promise<ExecutionResult> {
    const github = new GitHubClient();
    if (!github.isConfigured()) {
      // Fall back to generic execution without repo context
      return this.execute(request);
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return this.simulate(request);
    }

    const startTime = Date.now();
    const { repoOwner, repoName, instruction } = request;

    try {
      // 1. Search for relevant files
      const searchTerms = instruction
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 3);
      const searchResults = await github.searchCode(
        repoOwner,
        repoName,
        searchTerms.join(" "),
      );

      // 2. Read top relevant files (max 5, skip files > 20KB)
      const fileContents: Array<{ path: string; content: string; sha: string }> = [];
      for (const result of searchResults.slice(0, 5)) {
        const file = await github.readFile(repoOwner, repoName, result.path);
        if (file && file.content.length < 20_000) {
          fileContents.push({
            path: result.path,
            content: file.content,
            sha: file.sha,
          });
        }
      }

      // If no files found via search, get the file tree and pick likely candidates
      if (fileContents.length === 0) {
        const tree = await github.getFileTree(repoOwner, repoName);
        const srcFiles = tree.filter(
          (f) =>
            f.type === "file" &&
            (f.path.endsWith(".ts") ||
              f.path.endsWith(".js") ||
              f.path.endsWith(".tsx")),
        );
        for (const f of srcFiles.slice(0, 5)) {
          const file = await github.readFile(repoOwner, repoName, f.path);
          if (file && file.content.length < 20_000) {
            fileContents.push({
              path: f.path,
              content: file.content,
              sha: file.sha,
            });
          }
        }
      }

      // 3. Build context for Claude
      const fileContext = fileContents
        .map(
          (f) =>
            `### File: ${f.path}\n\`\`\`\n${f.content.slice(0, 5000)}\n\`\`\``,
        )
        .join("\n\n");

      const systemPrompt = `You are a senior software engineer working on the ${repoOwner}/${repoName} repository.

You have access to the following files from the codebase:

${fileContext}

When given an instruction:
1. Analyze the existing code
2. Make the specific changes needed
3. For EACH file you modify, output in this exact format:

===FILE: path/to/file.ts===
(complete updated file content)
===END===

Only include files you actually change. Include the COMPLETE file content, not just the diff.
Be precise and production-ready.`;

      const model = process.env.TASK_MODEL || "claude-sonnet-4-20250514";

      // Build message content with images if present
      const userContent = await this.buildUserContent(
        `Instruction: ${instruction}`,
        request.imageUrls,
      );

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }],
        }),
        signal: AbortSignal.timeout(request.timeout ?? 120_000),
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
      const output = data.content?.[0]?.text || "";

      // 4. Parse file changes from Claude's output
      const fileChanges = parseFileChanges(output);

      if (fileChanges.length === 0) {
        // Claude gave advice but no file changes — return as-is
        return {
          taskId: request.taskId,
          status: "completed",
          output: output.slice(0, 3000),
          durationMs: Date.now() - startTime,
          exitCode: 0,
          simulated: false,
        };
      }

      // 5. Create branch and commit changes
      const branchName = `codespar/${request.taskId.slice(0, 12)}`;
      const defaultBranch = await github.getDefaultBranch(repoOwner, repoName);
      const branchCreated = await github.createBranch(
        repoOwner,
        repoName,
        branchName,
        defaultBranch,
      );

      if (!branchCreated) {
        return {
          taskId: request.taskId,
          status: "failed",
          output: `Failed to create branch "${branchName}" from ${defaultBranch}`,
          durationMs: Date.now() - startTime,
          exitCode: null,
          simulated: false,
        };
      }

      for (const change of fileChanges) {
        // Find existing file SHA for updates (required by GitHub API)
        const existing = fileContents.find((f) => f.path === change.path);
        await github.updateFile(
          repoOwner,
          repoName,
          change.path,
          change.content,
          instruction.slice(0, 50),
          branchName,
          existing?.sha,
        );
      }

      // 6. Create PR
      const pr = await github.createPR(
        repoOwner,
        repoName,
        instruction.slice(0, 72),
        `## Changes\n\nGenerated by CodeSpar agent.\n\n**Instruction:** ${instruction}\n\n**Files changed:** ${fileChanges.map((f) => f.path).join(", ")}`,
        branchName,
        defaultBranch,
      );

      const prInfo = pr
        ? `\n\nPR #${pr.number} created: ${pr.url}`
        : "\n\n(PR creation failed)";
      const filesInfo = fileChanges
        .map((f) => `  - ${f.path}`)
        .join("\n");

      return {
        taskId: request.taskId,
        status: "completed",
        output: `Changes applied to ${fileChanges.length} file(s):\n${filesInfo}${prInfo}`,
        durationMs: Date.now() - startTime,
        exitCode: 0,
        simulated: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return {
        taskId: request.taskId,
        status: message.includes("timeout") ? "timeout" : "failed",
        output: `Error: ${message}`,
        durationMs: Date.now() - startTime,
        exitCode: null,
        simulated: false,
      };
    }
  }
}

/**
 * Parse Claude's output for file change blocks.
 *
 * Expected format:
 *   ===FILE: path/to/file.ts===
 *   (complete file content)
 *   ===END===
 */
function parseFileChanges(
  output: string,
): Array<{ path: string; content: string }> {
  const changes: Array<{ path: string; content: string }> = [];
  const regex = /===FILE:\s*(.+?)===\n([\s\S]*?)===END===/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    changes.push({ path: match[1].trim(), content: match[2].trim() });
  }
  return changes;
}
