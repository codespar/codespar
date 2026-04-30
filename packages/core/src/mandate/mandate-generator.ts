/**
 * MandateGenerator — OSS reference impl.
 *
 * Wire-compatible with @codespar-enterprise/mandate's MandateGenerator.
 * The HMAC-SHA256 signature payload is identical
 * (`id:agentId:amount:currency:expiresAt`) so a mandate issued by
 * either generator is verifiable by the other given the same secret.
 *
 * Both sync and async surfaces ship — the in-memory backend stays
 * synchronous for backwards compat with single-shot scripts; file
 * and Postgres backends are async.
 */

import { createHmac } from "node:crypto";
import { InMemoryMandateBackend } from "./in-memory-backend.js";
import type { Mandate, MandateBackend } from "./types.js";

export class MandateGenerator {
  readonly backend: MandateBackend;
  private secret: string;

  constructor(secret: string, backend?: MandateBackend) {
    if (!secret || secret.length < 16) {
      throw new Error("HMAC secret must be at least 16 characters");
    }
    this.secret = secret;
    this.backend = backend ?? new InMemoryMandateBackend();
  }

  create(params: CreateParams): Mandate {
    const mandate = this.buildMandate(params);
    const result = this.backend.put(mandate);
    if (isPromise(result)) {
      throw new Error(
        "Sync MandateGenerator.create() invoked against async backend — use createAsync()",
      );
    }
    return mandate;
  }

  async createAsync(params: CreateParams): Promise<Mandate> {
    const mandate = this.buildMandate(params);
    await this.backend.put(mandate);
    return mandate;
  }

  verify(mandate: Mandate): boolean {
    const expected = this.computeSignature(
      mandate.id,
      mandate.agentId,
      mandate.amount,
      mandate.currency,
      mandate.expiresAt,
    );
    return mandate.signature === expected;
  }

  use(mandateId: string): Mandate {
    const result = this.backend.markUsed(mandateId, new Date().toISOString());
    if (isPromise(result)) {
      throw new Error(
        "Sync MandateGenerator.use() invoked against async backend — use useAsync()",
      );
    }
    return result;
  }

  async useAsync(mandateId: string): Promise<Mandate> {
    return await this.backend.markUsed(mandateId, new Date().toISOString());
  }

  revoke(mandateId: string): Mandate {
    const result = this.backend.markRevoked(
      mandateId,
      new Date().toISOString(),
    );
    if (isPromise(result)) {
      throw new Error(
        "Sync MandateGenerator.revoke() invoked against async backend — use revokeAsync()",
      );
    }
    return result;
  }

  async revokeAsync(mandateId: string): Promise<Mandate> {
    return await this.backend.markRevoked(mandateId, new Date().toISOString());
  }

  getActive(): Mandate[] {
    const result = this.backend.getActive(new Date());
    if (isPromise(result)) {
      throw new Error(
        "Sync MandateGenerator.getActive() invoked against async backend — use getActiveAsync()",
      );
    }
    return result;
  }

  async getActiveAsync(): Promise<Mandate[]> {
    return await this.backend.getActive(new Date());
  }

  isValid(mandateId: string, transactionAmount?: number): boolean {
    const result = this.backend.get(mandateId);
    if (isPromise(result)) {
      throw new Error(
        "Sync MandateGenerator.isValid() invoked against async backend — use isValidAsync()",
      );
    }
    return this.checkValidity(result, transactionAmount);
  }

  async isValidAsync(
    mandateId: string,
    transactionAmount?: number,
  ): Promise<boolean> {
    const mandate = await this.backend.get(mandateId);
    return this.checkValidity(mandate, transactionAmount);
  }

  getMandate(id: string): Mandate | undefined {
    const result = this.backend.get(id);
    if (isPromise(result)) {
      throw new Error(
        "Sync MandateGenerator.getMandate() invoked against async backend — use getMandateAsync()",
      );
    }
    return result;
  }

  async getMandateAsync(id: string): Promise<Mandate | undefined> {
    return await this.backend.get(id);
  }

  /* ── private helpers ───────────────────────────────────────── */

  private buildMandate(params: CreateParams): Mandate {
    if (params.amount <= 0) {
      throw new Error("Mandate amount must be positive");
    }
    const signature = this.computeSignature(
      params.id,
      params.agentId,
      params.amount,
      params.currency,
      params.expiresAt,
    );
    return {
      id: params.id,
      type: params.type,
      authorizedBy: params.authorizedBy,
      agentId: params.agentId,
      amount: params.amount,
      currency: params.currency,
      maxAmount: params.maxAmount,
      description: params.description,
      conditions: params.conditions ?? [],
      signature,
      createdAt: new Date().toISOString(),
      expiresAt: params.expiresAt,
      orgId: params.orgId,
    };
  }

  private checkValidity(
    mandate: Mandate | undefined,
    transactionAmount?: number,
  ): boolean {
    if (!mandate) return false;
    if (mandate.usedAt) return false;
    if (mandate.revokedAt) return false;
    if (new Date(mandate.expiresAt) <= new Date()) return false;
    if (transactionAmount !== undefined && mandate.maxAmount !== undefined) {
      if (transactionAmount > mandate.maxAmount) return false;
    }
    return true;
  }

  private computeSignature(
    id: string,
    agentId: string,
    amount: number,
    currency: string,
    expiresAt: string,
  ): string {
    const payload = `${id}:${agentId}:${amount}:${currency}:${expiresAt}`;
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }
}

export interface CreateParams {
  id: string;
  type: "payment" | "subscription" | "delegation";
  authorizedBy: string;
  agentId: string;
  amount: number;
  currency: string;
  maxAmount?: number;
  description: string;
  conditions?: string[];
  expiresAt: string;
  orgId?: string;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Promise<T>).then === "function",
  );
}
