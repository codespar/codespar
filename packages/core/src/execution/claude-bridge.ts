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
import { createLogger } from "../observability/logger.js";
import { metrics } from "../observability/metrics.js";

const log = createLogger("claude-bridge");

/** Compute USD cost based on Anthropic pricing (as of 2025) */
function computeClaudeCost(model: string, inputTokens: number, outputTokens: number): number {
  // Pricing per million tokens
  const PRICING: Record<string, { input: number; output: number }> = {
    "claude-sonnet-4-20250514": { input: 3, output: 15 },
    "claude-haiku-4-20250414": { input: 0.80, output: 4 },
    "claude-opus-4-20250514": { input: 15, output: 75 },
  };
  // Match model prefix for flexibility
  const key = Object.keys(PRICING).find((k) => model.startsWith(k.split("-").slice(0, 3).join("-"))) || "";
  const price = PRICING[key] || { input: 3, output: 15 }; // default to Sonnet pricing
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export interface ProgressEvent {
  type: "status" | "code" | "file-selected" | "file-read" | "generating" | "branch" | "commit" | "pr";
  message: string;
  /** Code chunk being generated (for type "code") */
  code?: string;
  /** File path (for file operations) */
  filePath?: string;
}

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
  /** Progress callback for real-time updates */
  onProgress?: (event: ProgressEvent) => void;
}

export interface RepoExecutionRequest extends ExecutionRequest {
  repoOwner: string;
  repoName: string;
  /** Per-workspace GitHub token (from OAuth). Falls back to GITHUB_TOKEN env var. */
  githubToken?: string;
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

      const data = (await res.json()) as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      const output = data.content?.[0]?.text || "(no output)";
      const usage = data.usage;
      const inputTokens = usage?.input_tokens ?? 0;
      const outputTokens = usage?.output_tokens ?? 0;
      const durationMs = Date.now() - startTime;

      const costUsd = computeClaudeCost(model, inputTokens, outputTokens);
      log.info("Claude API call", { model, inputTokens, outputTokens, durationMs, costUsd, method: "execute" });
      metrics.increment("api.claude.calls");
      metrics.observe("api.claude.latency_ms", durationMs);
      metrics.observe("api.claude.tokens_in", inputTokens);
      metrics.observe("api.claude.tokens_out", outputTokens);

      return {
        taskId: request.taskId,
        status: "completed",
        output: output.slice(0, 3000), // Limit output size
        durationMs,
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
      let streamInputTokens = 0;
      let streamOutputTokens = 0;

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
              } else if (event.type === "message_start" && event.message?.usage?.input_tokens) {
                streamInputTokens = event.message.usage.input_tokens;
              } else if (event.type === "message_delta" && event.usage?.output_tokens) {
                streamOutputTokens = event.usage.output_tokens;
              }
            } catch {
              /* skip malformed JSON */
            }
          }
        }
      }

      const durationMs = Date.now() - startTime;
      const costUsd = computeClaudeCost(model, streamInputTokens, streamOutputTokens);
      log.info("Claude API call", { model, inputTokens: streamInputTokens, outputTokens: streamOutputTokens, durationMs, costUsd, method: "executeStreaming" });
      metrics.increment("api.claude.calls");
      metrics.observe("api.claude.latency_ms", durationMs);
      metrics.observe("api.claude.tokens_in", streamInputTokens);
      metrics.observe("api.claude.tokens_out", streamOutputTokens);

      return {
        taskId: request.taskId,
        status: "completed",
        output: fullOutput.slice(0, 3000),
        durationMs,
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
        if (img.url.includes("slack") || img.url.includes("files.slack.com")) {
          const slackToken = process.env.SLACK_BOT_TOKEN;
          if (slackToken) {
            headers["Authorization"] = `Bearer ${slackToken}`;
          }
        }

        console.log(`[claude-bridge] Downloading image: ${img.url.slice(0, 100)}`);
        console.log(`[claude-bridge] Auth header: ${headers["Authorization"] ? "Bearer ..." : "none"}`);

        const imgRes = await fetch(img.url, { headers, redirect: "follow" });
        if (!imgRes.ok) {
          console.log(`[claude-bridge] Image download failed: ${imgRes.status} ${img.url.slice(0, 80)}`);
          continue;
        }

        const contentType = imgRes.headers.get("content-type") || "";
        console.log(`[claude-bridge] Response content-type: ${contentType}`);

        // If response is HTML, it's a login redirect, not an image
        if (contentType.includes("text/html")) {
          console.log(`[claude-bridge] Got HTML instead of image (auth redirect?), skipping`);
          continue;
        }

        const buffer = await imgRes.arrayBuffer();

        // Skip images larger than 4MB (Claude limit ~5MB, leave margin)
        if (buffer.byteLength > 4 * 1024 * 1024) {
          console.log(`[claude-bridge] Image too large: ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB, skipping`);
          continue;
        }

        // Verify it looks like a real image (check magic bytes)
        const firstBytes = new Uint8Array(buffer.slice(0, 4));
        const isPNG = firstBytes[0] === 0x89 && firstBytes[1] === 0x50;
        const isJPEG = firstBytes[0] === 0xFF && firstBytes[1] === 0xD8;
        const isGIF = firstBytes[0] === 0x47 && firstBytes[1] === 0x49;
        const isWEBP = firstBytes[0] === 0x52 && firstBytes[1] === 0x49;

        if (!isPNG && !isJPEG && !isGIF && !isWEBP) {
          const preview = Buffer.from(buffer.slice(0, 100)).toString("utf-8");
          console.log(`[claude-bridge] Not a valid image file. First bytes: ${preview.slice(0, 80)}`);
          continue;
        }

        const base64 = Buffer.from(buffer).toString("base64");

        // Determine media type from actual content, not headers
        let mediaType = "image/png";
        if (isJPEG) mediaType = "image/jpeg";
        else if (isPNG) mediaType = "image/png";
        else if (isGIF) mediaType = "image/gif";
        else if (isWEBP) mediaType = "image/webp";

        console.log(`[claude-bridge] Image loaded: ${mediaType}, ${(buffer.byteLength / 1024).toFixed(0)}KB`);

        contentParts.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64,
          },
        });
      } catch (err) {
        console.log(`[claude-bridge] Image download error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Always include the text instruction
    contentParts.push({ type: "text", text });

    // If no images were successfully downloaded, return plain text
    return contentParts.length > 1 ? contentParts : text;
  }

  /**
   * Detect the natural language of a file's content using simple heuristics.
   * Returns a language hint string (e.g., "Brazilian Portuguese", "English") or null.
   */
  private detectLanguage(content: string): string | null {
    const sample = content.slice(0, 3000).toLowerCase();

    // Portuguese indicators: accented characters + common words
    const ptChars = (sample.match(/[ãõçéêáàâúíó]/g) || []).length;
    const ptWords = [
      "como", "para", "projeto", "instalação", "configuração",
      "utilização", "sobre", "funcionalidades", "tecnologias",
      "executar", "rodar", "desenvolvimento", "contribuição",
      "pré-requisitos", "estrutura", "descrição", "variáveis",
    ];
    const ptHits = ptWords.filter((w) => sample.includes(w)).length;

    if (ptChars >= 3 || ptHits >= 2) return "Brazilian Portuguese";

    // Spanish indicators
    const esWords = ["proyecto", "instalación", "configuración", "desarrollo", "contribuir", "requisitos"];
    const esHits = esWords.filter((w) => sample.includes(w)).length;
    if (esHits >= 2) return "Spanish";

    return "English";
  }

  /**
   * Read project context files (CLAUDE.md, README, package.json, architecture docs).
   * Returns a string with the aggregated context for the system prompt.
   */
  private async gatherProjectContext(
    github: GitHubClient,
    owner: string,
    repo: string,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<{ context: string; language: string | null }> {
    const contextFiles = [
      "CLAUDE.md",
      "README.md",
      "ARCHITECTURE.md",
      "PLAN.md",
      "MVP-PLAN.md",
      "CONTRIBUTING.md",
    ];

    const sections: string[] = [];
    let detectedLanguage: string | null = null;

    onProgress?.({ type: "status", message: "Gathering project context..." });

    for (const filePath of contextFiles) {
      try {
        const file = await github.readFile(owner, repo, filePath);
        if (file && file.content.length > 0 && file.content.length < 30_000) {
          // Truncate large context files to keep prompt manageable
          const truncated = file.content.slice(0, 8000);
          sections.push(`### ${filePath}\n${truncated}`);

          // Detect language from README (most reliable indicator)
          if (filePath.toLowerCase().startsWith("readme") && !detectedLanguage) {
            detectedLanguage = this.detectLanguage(file.content);
          }

          onProgress?.({ type: "file-read", message: `Context: ${filePath}`, filePath });
        }
      } catch {
        // File doesn't exist, skip silently
      }
    }

    // Also read package.json for tech stack context (smaller, always useful)
    try {
      const pkg = await github.readFile(owner, repo, "package.json");
      if (pkg && pkg.content.length < 10_000) {
        // Extract only name, description, dependencies keys
        try {
          const parsed = JSON.parse(pkg.content);
          const slim = {
            name: parsed.name,
            description: parsed.description,
            dependencies: parsed.dependencies ? Object.keys(parsed.dependencies) : [],
            devDependencies: parsed.devDependencies ? Object.keys(parsed.devDependencies) : [],
          };
          sections.push(`### package.json (summary)\n\`\`\`json\n${JSON.stringify(slim, null, 2)}\n\`\`\``);
        } catch {
          // Invalid JSON, skip
        }
      }
    } catch {
      // No package.json
    }

    return {
      context: sections.length > 0 ? sections.join("\n\n") : "",
      language: detectedLanguage,
    };
  }

  /**
   * Recursively get the full file tree of a repository.
   * GitHub contents API only returns one level, so we recurse into directories.
   */
  private async getFullFileTree(
    github: GitHubClient,
    owner: string,
    repo: string,
    path = "",
    depth = 0,
  ): Promise<string[]> {
    if (depth > 4) return []; // Max 4 levels deep
    const entries = await github.getFileTree(owner, repo, path);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.type === "file") {
        files.push(entry.path);
      } else if (
        entry.type === "dir" &&
        !entry.path.startsWith(".") &&
        entry.path !== "node_modules" &&
        entry.path !== "dist" &&
        entry.path !== ".next"
      ) {
        const nested = await this.getFullFileTree(github, owner, repo, entry.path, depth + 1);
        files.push(...nested);
      }
    }
    return files;
  }

  /**
   * Use Claude to pick the most relevant files for an instruction.
   * Sends the file tree and instruction, asks Claude to return file paths.
   */
  private async pickRelevantFiles(
    apiKey: string,
    instruction: string,
    filePaths: string[],
    imageUrls?: Array<{ url: string; mimeType?: string }>,
  ): Promise<string[]> {
    const model = process.env.NLU_MODEL || "claude-haiku-4-5-20251001";

    const fileList = filePaths.slice(0, 500).join("\n");

    const prompt = `You are a code assistant. Given a user's instruction and a list of file paths from a repository, pick the 3-15 most relevant files that would need to be read or modified to fulfill the instruction. For refactoring tasks, err on the side of including more files.

INSTRUCTION: ${instruction}

FILE TREE:
${fileList}

Respond with ONLY the file paths, one per line. No explanations, no markdown, no numbering. Just the raw file paths.`;

    try {
      const contentParts: Array<Record<string, unknown>> = [];

      // Include images if available (helps Claude understand UI issues)
      if (imageUrls && imageUrls.length > 0) {
        for (const img of imageUrls) {
          try {
            const headers: Record<string, string> = {};
            if (img.url.includes("slack") || img.url.includes("files.slack.com")) {
              const slackToken = process.env.SLACK_BOT_TOKEN;
              if (slackToken) headers["Authorization"] = `Bearer ${slackToken}`;
            }
            const imgRes = await fetch(img.url, { headers, redirect: "follow" });
            if (!imgRes.ok) continue;
            const ct = imgRes.headers.get("content-type") || "";
            if (ct.includes("text/html")) continue;
            const buffer = await imgRes.arrayBuffer();
            if (buffer.byteLength > 4 * 1024 * 1024) continue;
            const firstBytes = new Uint8Array(buffer.slice(0, 4));
            const isPNG = firstBytes[0] === 0x89 && firstBytes[1] === 0x50;
            const isJPEG = firstBytes[0] === 0xFF && firstBytes[1] === 0xD8;
            if (!isPNG && !isJPEG) continue;
            contentParts.push({
              type: "image",
              source: {
                type: "base64",
                media_type: isPNG ? "image/png" : "image/jpeg",
                data: Buffer.from(buffer).toString("base64"),
              },
            });
          } catch { /* skip */ }
        }
      }

      contentParts.push({ type: "text", text: prompt });

      const pickStart = Date.now();
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          messages: [{ role: "user", content: contentParts.length > 1 ? contentParts : prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) return [];

      const data = (await res.json()) as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      const text = data.content?.[0]?.text || "";

      const pickUsage = data.usage;
      const pickInputTokens = pickUsage?.input_tokens ?? 0;
      const pickOutputTokens = pickUsage?.output_tokens ?? 0;
      const pickDurationMs = Date.now() - pickStart;
      const pickCostUsd = computeClaudeCost(model, pickInputTokens, pickOutputTokens);
      log.info("Claude API call", { model, inputTokens: pickInputTokens, outputTokens: pickOutputTokens, durationMs: pickDurationMs, costUsd: pickCostUsd, method: "pickRelevantFiles" });
      metrics.increment("api.claude.calls");
      metrics.observe("api.claude.latency_ms", pickDurationMs);
      metrics.observe("api.claude.tokens_in", pickInputTokens);
      metrics.observe("api.claude.tokens_out", pickOutputTokens);

      // Parse file paths from response (one per line, filter to paths that exist in our tree)
      const pathSet = new Set(filePaths);
      return text
        .split("\n")
        .map((line) => line.trim().replace(/^[-*\d.)\s]+/, "").trim())
        .filter((line) => pathSet.has(line));
    } catch (err) {
      console.log(`[claude-bridge] File picker error: ${err instanceof Error ? err.message : String(err)}`);
      return [];
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
    const github = new GitHubClient(request.githubToken);
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
      // 1. Get the full file tree so Claude can pick the right files
      const fullTree = await this.getFullFileTree(github, repoOwner, repoName);
      const srcFiles = fullTree.filter(
        (f) =>
          f.endsWith(".ts") ||
          f.endsWith(".tsx") ||
          f.endsWith(".js") ||
          f.endsWith(".jsx") ||
          f.endsWith(".css") ||
          f.endsWith(".json") ||
          f.endsWith(".md") ||
          f.endsWith(".mdx") ||
          f.endsWith(".yaml") ||
          f.endsWith(".yml"),
      );

      console.log(`[claude-bridge] File tree: ${srcFiles.length} source files in ${repoOwner}/${repoName}`);
      request.onProgress?.({ type: "status", message: `Scanning codebase... (${srcFiles.length} files)` });

      // 1b. Gather project context (README, CLAUDE.md, architecture docs, package.json)
      const { context: projectContext, language: detectedLanguage } = await this.gatherProjectContext(
        github, repoOwner, repoName, request.onProgress,
      );
      if (detectedLanguage) {
        log.info("Detected project language", { language: detectedLanguage, repo: `${repoOwner}/${repoName}` });
      }

      // 2. Ask Claude which files are relevant to the instruction
      request.onProgress?.({ type: "status", message: "Selecting relevant files..." });
      const relevantPaths = await this.pickRelevantFiles(
        apiKey, instruction, srcFiles, request.imageUrls,
      );

      console.log(`[claude-bridge] Claude picked ${relevantPaths.length} files: ${relevantPaths.join(", ")}`);
      for (const p of relevantPaths) {
        request.onProgress?.({ type: "file-selected", message: `Selected: ${p}`, filePath: p });
      }

      // 3. Read the selected files
      const fileContents: Array<{ path: string; content: string; sha: string }> = [];
      for (const filePath of relevantPaths.slice(0, 15)) {
        request.onProgress?.({ type: "file-read", message: `Reading: ${filePath}`, filePath });
        const file = await github.readFile(repoOwner, repoName, filePath);
        if (file && file.content.length < 30_000) {
          fileContents.push({
            path: filePath,
            content: file.content,
            sha: file.sha,
          });
        }
      }

      // 4. Fallback: if Claude picked nothing or files don't exist, try keyword search
      if (fileContents.length === 0) {
        console.log(`[claude-bridge] Claude file pick returned nothing, falling back to keyword search`);
        const searchTerms = instruction
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .slice(0, 3);
        const searchResults = await github.searchCode(
          repoOwner, repoName, searchTerms.join(" "),
        );
        for (const result of searchResults.slice(0, 5)) {
          const file = await github.readFile(repoOwner, repoName, result.path);
          if (file && file.content.length < 30_000) {
            fileContents.push({
              path: result.path,
              content: file.content,
              sha: file.sha,
            });
          }
        }
      }

      // 3. Build context for Claude (full file content, up to 20KB per file)
      const fileContext = fileContents
        .map(
          (f) =>
            `### File: ${f.path}\n\`\`\`\n${f.content.slice(0, 20000)}\n\`\`\``,
        )
        .join("\n\n");

      // Build language and context instructions
      const languageInstruction = detectedLanguage
        ? `\n\nIMPORTANT: The project's documentation is written in ${detectedLanguage}. You MUST preserve the same language in any documentation or text files you modify. Do not switch languages unless explicitly asked.`
        : "";

      const contextSection = projectContext
        ? `\n\n## Project Context\nThe following documentation was found in the repository. Use it to understand the project's conventions, architecture, and goals:\n\n${projectContext}`
        : "";

      const systemPrompt = `You are a senior software engineer working on the ${repoOwner}/${repoName} repository.
${contextSection}

## Files from the codebase

${fileContext}
${languageInstruction}

When given an instruction:
1. Analyze the existing code and project context
2. Understand the existing conventions, structure, and language before making changes
3. Make ONLY the specific changes needed — preserve the existing style, tone, and language
4. For EACH file you modify, output ONLY the changed sections using this format:

===DIFF: path/to/file.ts===
<<<SEARCH
(exact lines to find in the original file)
>>>REPLACE
(replacement lines)
===END===

You can have multiple SEARCH/REPLACE blocks per file. Keep each block small and focused.
Do NOT output the entire file. Only output the specific lines that change, with enough context (2-3 surrounding lines) to locate them uniquely.
For refactoring tasks that touch many files, output diffs for ALL affected files. Do not skip files.
Be precise and production-ready.`;

      const model = process.env.TASK_MODEL || "claude-sonnet-4-20250514";

      // Build message content with images if present
      const userContent = await this.buildUserContent(
        `Instruction: ${instruction}`,
        request.imageUrls,
      );

      // Use multi-turn if needed: initial request + continuation
      const messages: Array<Record<string, unknown>> = [
        { role: "user", content: userContent },
      ];

      let fullOutput = "";

      request.onProgress?.({ type: "generating", message: "Generating changes..." });

      // Allow up to 2 turns (initial + 1 continuation)
      for (let turn = 0; turn < 2; turn++) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 8192,
            stream: true,
            system: systemPrompt,
            messages,
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

        let turnOutput = "";
        let stopReason = "";
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = "";

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const sseLines = sseBuffer.split("\n");
            sseBuffer = sseLines.pop() || "";
            for (const sseLine of sseLines) {
              if (!sseLine.startsWith("data: ")) continue;
              const sseData = sseLine.slice(6).trim();
              if (sseData === "[DONE]") continue;
              try {
                const sseEvent = JSON.parse(sseData);
                if (sseEvent.type === "content_block_delta" && sseEvent.delta?.text) {
                  turnOutput += sseEvent.delta.text;
                  request.onProgress?.({ type: "code", message: "", code: sseEvent.delta.text });
                } else if (sseEvent.type === "message_delta" && sseEvent.delta?.stop_reason) {
                  stopReason = sseEvent.delta.stop_reason;
                }
              } catch { /* skip malformed JSON */ }
            }
          }
        }

        fullOutput += turnOutput;

        // If Claude finished naturally, we're done
        if (stopReason !== "max_tokens") break;

        // If truncated, ask to continue
        console.log(`[claude-bridge] Response truncated at turn ${turn + 1}, requesting continuation`);
        messages.push({ role: "assistant", content: turnOutput });
        messages.push({ role: "user", content: "Continue from where you left off. Complete the remaining changes." });
      }

      // 4. Parse file changes from Claude's output (supports both DIFF and FILE formats)
      let fileChanges = parseDiffChanges(fullOutput, fileContents);

      // Fallback: try legacy ===FILE:=== format
      if (fileChanges.length === 0) {
        fileChanges = parseFileChanges(fullOutput);
      }

      request.onProgress?.({ type: "status", message: `Parsed ${fileChanges.length} file change(s)` });

      if (fileChanges.length === 0) {
        // Claude gave advice but no file changes
        return {
          taskId: request.taskId,
          status: "completed",
          output: fullOutput.slice(0, 5000),
          durationMs: Date.now() - startTime,
          exitCode: 0,
          simulated: false,
        };
      }

      // 5. Create branch and commit changes
      const branchName = `codespar/${request.taskId.slice(0, 12)}`;
      request.onProgress?.({ type: "branch", message: `Creating branch: ${branchName}` });
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
        request.onProgress?.({ type: "commit", message: `Committing: ${change.path}`, filePath: change.path });
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
      request.onProgress?.({ type: "pr", message: "Opening pull request..." });
      const pr = await github.createPR(
        repoOwner,
        repoName,
        instruction.slice(0, 72),
        `## Changes\n\nGenerated by CodeSpar agent.\n\n**Instruction:** ${instruction}\n\n**Files changed:** ${fileChanges.map((f) => f.path).join(", ")}`,
        branchName,
        defaultBranch,
      );

      if (pr) {
        request.onProgress?.({ type: "pr", message: `PR #${pr.number} created: ${pr.url}` });
      }
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
 * Parse Claude's output for file change blocks (legacy full-file format).
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

/**
 * Parse Claude's diff-based output and apply changes to original files.
 *
 * Expected format:
 *   ===DIFF: path/to/file.ts===
 *   <<<SEARCH
 *   (lines to find)
 *   >>>REPLACE
 *   (replacement lines)
 *   ===END===
 */
function parseDiffChanges(
  output: string,
  originalFiles: Array<{ path: string; content: string; sha: string }>,
): Array<{ path: string; content: string }> {
  const changes: Array<{ path: string; content: string }> = [];
  const diffRegex = /===DIFF:\s*(.+?)===\n([\s\S]*?)===END===/g;
  let diffMatch;

  while ((diffMatch = diffRegex.exec(output)) !== null) {
    const filePath = diffMatch[1].trim();
    const diffBody = diffMatch[2];

    // Find the original file
    const original = originalFiles.find((f) => f.path === filePath);
    if (!original) {
      console.log(`[claude-bridge] Diff references unknown file: ${filePath}`);
      continue;
    }

    let content = original.content;

    // Apply each SEARCH/REPLACE block
    const blockRegex = /<<<SEARCH\n([\s\S]*?)>>>REPLACE\n([\s\S]*?)(?=<<<SEARCH|$)/g;
    let blockMatch;
    let applied = 0;

    while ((blockMatch = blockRegex.exec(diffBody)) !== null) {
      const search = blockMatch[1].trimEnd();
      const replace = blockMatch[2].trimEnd();

      if (content.includes(search)) {
        content = content.replace(search, replace);
        applied++;
      } else {
        // Try with trimmed whitespace
        const searchTrimmed = search.trim();
        const lines = content.split("\n");
        let found = false;
        for (let i = 0; i < lines.length; i++) {
          // Find a line that contains the first line of search
          const firstSearchLine = searchTrimmed.split("\n")[0].trim();
          if (lines[i].trim().includes(firstSearchLine.trim())) {
            // Try matching from this position
            const searchLines = searchTrimmed.split("\n");
            let match = true;
            for (let j = 0; j < searchLines.length && i + j < lines.length; j++) {
              if (lines[i + j].trim() !== searchLines[j].trim()) {
                match = false;
                break;
              }
            }
            if (match) {
              const replaceLines = replace.trim().split("\n");
              // Preserve original indentation of first line
              const indent = lines[i].match(/^\s*/)?.[0] || "";
              const indentedReplace = replaceLines.map((l, idx) =>
                idx === 0 ? indent + l.trim() : indent + l.trim()
              );
              lines.splice(i, searchLines.length, ...indentedReplace);
              content = lines.join("\n");
              found = true;
              applied++;
              break;
            }
          }
        }
        if (!found) {
          console.log(`[claude-bridge] Could not find search block in ${filePath}: ${search.slice(0, 60)}...`);
        }
      }
    }

    if (applied > 0) {
      console.log(`[claude-bridge] Applied ${applied} diff block(s) to ${filePath}`);
      changes.push({ path: filePath, content });
    }
  }

  return changes;
}
