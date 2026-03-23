/**
 * Lens Agent - Data Analyst Agent for CodeSpar.
 *
 * Queries databases, analyzes data, and generates insights.
 * Connects to data sources via MCP or direct database URLs.
 * Uses Claude to write SQL, interpret results, and explain findings.
 *
 * Usage:
 *   @codespar lens what was our revenue last month?
 *   @codespar lens top 10 customers by spend
 *   @codespar lens show user growth trend since January
 */

import type {
  Agent, AgentConfig, AgentState, AgentStatus,
  NormalizedMessage, ChannelResponse, ParsedIntent,
} from "@codespar/core";

export interface LensQuery {
  id: string;
  question: string;
  generatedSQL?: string;
  result?: LensResult;
  status: "pending" | "running" | "completed" | "failed";
  durationMs?: number;
  error?: string;
}

export interface LensResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  summary: string;
  visualization?: LensVisualization;
}

export interface LensVisualization {
  type: "bar" | "line" | "pie" | "table" | "metric";
  title: string;
  data: Record<string, unknown>;
}

export interface DataSource {
  name: string;
  type: "postgresql" | "mysql" | "sqlite" | "bigquery" | "snowflake" | "redshift";
  connectionUrl?: string;
  schema?: string;
  tables?: string[];
}

export class LensAgent implements Agent {
  readonly config: AgentConfig;
  private _state: AgentState = "INITIALIZING";
  private queryHistory: LensQuery[] = [];
  private dataSources: DataSource[] = [];

  constructor(config: AgentConfig, dataSources?: DataSource[]) {
    this.config = { ...config, type: "lens" };
    this.dataSources = dataSources || [];
  }

  get state(): AgentState { return this._state; }

  async initialize(): Promise<void> {
    this._state = "IDLE";
  }

  async handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent,
  ): Promise<ChannelResponse> {
    this._state = "ACTIVE";

    const question = intent.params.question || intent.rawText;
    const queryId = `lens-${Date.now()}`;
    const query: LensQuery = { id: queryId, question, status: "pending" };
    this.queryHistory.push(query);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      query.status = "failed";
      query.error = "No API key";
      this._state = "IDLE";
      return { text: `[Lens] API key required for data analysis.` };
    }

    query.status = "running";
    const startTime = Date.now();

    try {
      // Build context about available data sources
      const dataContext = this.dataSources.length > 0
        ? `Available data sources:\n${this.dataSources.map(ds => `- ${ds.name} (${ds.type})${ds.tables ? `: tables [${ds.tables.join(", ")}]` : ""}`).join("\n")}`
        : "No specific data sources configured. Generate example SQL for a typical PostgreSQL database.";

      const systemPrompt = `You are Lens, a data analyst agent. You help teams understand their data by writing SQL queries, analyzing results, and explaining findings clearly.

${dataContext}

When the user asks a data question:
1. Write the SQL query that answers their question
2. Explain what the query does in plain language
3. Describe what insights the results would show
4. Suggest a visualization type (bar, line, pie, table, or metric) that best represents the data
5. If relevant, suggest follow-up questions

Format your response as:

**Query:**
\`\`\`sql
SELECT ...
\`\`\`

**What this does:** [plain language explanation]

**Expected insights:** [what the data would reveal]

**Visualization:** [chart type] - [why this type]

**Follow-up questions:**
- [suggestion 1]
- [suggestion 2]

Be concise. Focus on actionable insights, not generic descriptions.`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.LENS_MODEL || "claude-sonnet-4-20250514",
          max_tokens: 2000,
          system: systemPrompt,
          messages: [{ role: "user", content: question }],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        query.status = "failed";
        query.error = `API error: ${res.status}`;
        query.durationMs = Date.now() - startTime;
        this._state = "IDLE";
        return { text: `[Lens] Analysis failed: ${res.status} ${errText.slice(0, 100)}` };
      }

      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      const output = data.content?.[0]?.text || "";

      // Extract SQL from the response
      const sqlMatch = output.match(/```sql\n([\s\S]*?)```/);
      query.generatedSQL = sqlMatch ? sqlMatch[1].trim() : undefined;
      query.status = "completed";
      query.durationMs = Date.now() - startTime;

      const duration = query.durationMs < 1000
        ? `${query.durationMs}ms`
        : `${(query.durationMs / 1000).toFixed(1)}s`;

      this._state = "IDLE";
      return {
        text: [
          `[Lens] Analysis complete (${duration})`,
          `  Question: ${question}`,
          "",
          output,
        ].join("\n"),
      };
    } catch (err) {
      query.status = "failed";
      query.error = err instanceof Error ? err.message : "Unknown error";
      query.durationMs = Date.now() - startTime;
      this._state = "IDLE";
      return { text: `[Lens] Analysis failed: ${query.error}` };
    }
  }

  /** Get query history */
  getHistory(): LensQuery[] {
    return [...this.queryHistory];
  }

  /** Add a data source */
  addDataSource(source: DataSource): void {
    this.dataSources.push(source);
  }

  /** Get configured data sources */
  getDataSources(): DataSource[] {
    return [...this.dataSources];
  }

  getStatus(): AgentStatus {
    return {
      id: this.config.id,
      type: "lens",
      state: this._state,
      autonomyLevel: this.config.autonomyLevel,
      projectId: this.config.projectId,
      orgId: this.config.orgId,
      lastActiveAt: new Date(),
      uptimeMs: 0,
      tasksHandled: this.queryHistory.length,
    };
  }

  async shutdown(): Promise<void> {
    this._state = "TERMINATED";
  }
}
