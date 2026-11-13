import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Values the adapter accepts as bound parameters (booleans become 0/1). */
export type D1Value = string | number | boolean | null;

/** One parameterized statement. Placeholders are positional `?` markers. */
export interface D1Statement {
  readonly sql: string;
  readonly params?: readonly D1Value[];
}

/**
 * Typed per-statement result. Row payloads stay `unknown`-shaped by default;
 * callers narrow with the `query<T>()` type argument.
 */
export interface D1StatementResult<T = Record<string, unknown>> {
  readonly rows: readonly T[];
  readonly changes: number;
  readonly lastRowId: number | null;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/**
 * Sole D1 management/local transport for operational tools. Implementations
 * never log SQL, parameters, credentials or response data; diagnostics carry
 * sanitized status metadata only.
 */
export interface D1Adapter {
  readonly target: "local" | "remote";
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly D1Value[],
  ): Promise<D1StatementResult<T>>;
  batch(
    statements: readonly D1Statement[],
  ): Promise<D1StatementResult<Record<string, unknown>>[]>;
}

/** Sanitized transport failure. Never contains SQL, params, tokens or data. */
export class D1Error extends Error {
  readonly target?: "local" | "remote";
  readonly status?: number;
  readonly statementIndex?: number;

  constructor(
    message: string,
    options?: {
      readonly target?: "local" | "remote";
      readonly status?: number;
      readonly statementIndex?: number;
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "D1Error";
    this.target = options?.target;
    this.status = options?.status;
    this.statementIndex = options?.statementIndex;
  }
}

/** Credentials for the Cloudflare D1 management API transport. */
export interface RemoteD1Config {
  readonly accountId: string;
  readonly databaseId: string;
  readonly token: string;
}

/** Remote HTTP timeout, matching the existing operational-tool pattern. */
export const REMOTE_TIMEOUT_MS = 60_000;
/** Maximum statements per management API batch request. */
export const MAX_BATCH_STATEMENTS = 50;
/** Maximum encoded JSON body bytes per management API batch request. */
export const MAX_BATCH_BODY_BYTES = 512 * 1024;
/**
 * Maximum rendered UTF-8 bytes per local statement. Wrangler renders file
 * contents below its own statement limit; this stays well under it.
 */
export const MAX_LOCAL_STATEMENT_BYTES = 100_000;

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const DATABASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configError(name: string): D1Error {
  return new D1Error(
    `D1 remote transport is missing or has an invalid ${name}`,
    {
      target: "remote",
    },
  );
}

/**
 * Read remote credentials from the environment. `env` defaults to
 * `process.env` and exists for testability.
 */
export function readRemoteConfig(
  env: Record<string, string | undefined> = process.env,
): RemoteD1Config {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const databaseId = env.CLOUDFLARE_DATABASE_ID ?? "";
  const token = env.CLOUDFLARE_D1_API_TOKEN ?? "";
  if (!ACCOUNT_ID.test(accountId)) throw configError("CLOUDFLARE_ACCOUNT_ID");
  if (!DATABASE_ID.test(databaseId))
    throw configError("CLOUDFLARE_DATABASE_ID");
  if (token.length === 0) throw configError("CLOUDFLARE_D1_API_TOKEN");
  return { accountId, databaseId, token };
}

/**
 * Render one bound value as a SQLite literal. Rejects non-finite numbers,
 * unsupported types and embedded NUL; callers must never pass identifiers.
 */
export function encodeSQLiteLiteral(value: D1Value): string {
  if (value === null) return "NULL";
  if (value === true) return "1";
  if (value === false) return "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new D1Error(
        "Cannot encode a non-finite number as a SQLite literal",
        {
          target: "local",
        },
      );
    return String(value);
  }
  if (typeof value === "string") {
    if (value.includes("\0"))
      throw new D1Error("Cannot encode NUL in a SQLite literal", {
        target: "local",
      });
    return `'${value.replace(/'/g, "''")}'`;
  }
  throw new D1Error("Cannot encode an unsupported value as a SQLite literal", {
    target: "local",
  });
}

/**
 * Substitute positional `?` placeholders outside string literals with encoded
 * literals. Rejects placeholder/parameter count mismatches and oversized
 * statements. Never renders input identifiers.
 */
export function renderStatement(statement: D1Statement): string {
  const params = statement.params ?? [];
  const parts: string[] = [];
  let used = 0;
  let quote: "'" | '"' | "`" | null = null;
  let runStart = 0;
  const flush = (end: number): void => {
    if (end > runStart) parts.push(statement.sql.slice(runStart, end));
  };
  for (let i = 0; i < statement.sql.length; i += 1) {
    const char = statement.sql[i];
    if (quote !== null) {
      if (char === quote) {
        if (statement.sql[i + 1] === quote) {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "?") {
      const value = params[used];
      if (value === undefined)
        throw new D1Error(
          `D1 local statement has more placeholders than parameters (${String(used)} provided)`,
          { target: "local" },
        );
      used += 1;
      flush(i);
      parts.push(encodeSQLiteLiteral(value));
      runStart = i + 1;
    }
  }
  flush(statement.sql.length);
  if (used !== params.length)
    throw new D1Error(
      `D1 local statement has ${String(params.length)} parameters but ${String(used)} placeholders`,
      { target: "local" },
    );
  const rendered = parts.join("");
  if (rendered.trim().length === 0)
    throw new D1Error("D1 local statement is empty", { target: "local" });
  if (Buffer.byteLength(rendered, "utf8") > MAX_LOCAL_STATEMENT_BYTES)
    throw new D1Error(
      `D1 local statement exceeds ${String(MAX_LOCAL_STATEMENT_BYTES)} bytes`,
      { target: "local" },
    );
  return rendered;
}

/** Options for {@link splitBatches}. */
export interface SplitBatchesOptions {
  readonly maxStatements?: number;
  readonly maxBodyBytes?: number;
}

function encodedStatementSize(statement: D1Statement): number {
  return Buffer.byteLength(
    JSON.stringify({ sql: statement.sql, params: statement.params ?? [] }),
    "utf8",
  );
}

/** Encoded bytes of the `{"batch":[]}` envelope around joined statements. */
const BATCH_ENVELOPE_BYTES = 12;

/**
 * Split statements into bounded management API batches of at most 50
 * statements and 512 KiB encoded body each. Every input statement lands in
 * exactly one output batch, in order; oversized single statements throw.
 */
export function splitBatches(
  statements: readonly D1Statement[],
  options: SplitBatchesOptions = {},
): D1Statement[][] {
  const maxStatements = options.maxStatements ?? MAX_BATCH_STATEMENTS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BATCH_BODY_BYTES;
  if (!Number.isInteger(maxStatements) || maxStatements < 1)
    throw new D1Error("D1 batch limit must be a positive integer");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1)
    throw new D1Error("D1 batch body limit must be a positive integer");
  const batches: D1Statement[][] = [];
  let current: D1Statement[] = [];
  let currentBytes = BATCH_ENVELOPE_BYTES;
  for (const statement of statements) {
    if (statement.params !== undefined && statement.params.length > 100)
      throw new D1Error(
        "D1 statement exceeds the 100-parameter management API limit",
      );
    const size = encodedStatementSize(statement);
    if (BATCH_ENVELOPE_BYTES + size > maxBodyBytes)
      throw new D1Error(
        `D1 statement exceeds the ${String(maxBodyBytes)}-byte batch body limit`,
      );
    if (
      current.length >= maxStatements ||
      currentBytes + size + (current.length > 0 ? 1 : 0) > maxBodyBytes
    ) {
      batches.push(current);
      current = [];
      currentBytes = BATCH_ENVELOPE_BYTES;
    }
    current.push(statement);
    currentBytes += size + (current.length > 1 ? 1 : 0);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Execute statements through `adapter` in bounded sequential batches,
 * returning per-statement results in input order.
 */
export async function executeBounded(
  adapter: D1Adapter,
  statements: readonly D1Statement[],
  options: SplitBatchesOptions = {},
): Promise<D1StatementResult<Record<string, unknown>>[]> {
  const results: D1StatementResult<Record<string, unknown>>[] = [];
  for (const batch of splitBatches(statements, options)) {
    const part = await adapter.batch(batch);
    if (part.length !== batch.length)
      throw new D1Error(
        `D1 ${adapter.target} transport returned ${String(part.length)} results for ${String(batch.length)} statements`,
        { target: adapter.target },
      );
    results.push(...part);
  }
  return results;
}

interface ManagementMeta {
  readonly changed_db?: unknown;
  readonly changes?: unknown;
  readonly duration?: unknown;
  readonly last_row_id?: unknown;
  readonly rows_read?: unknown;
  readonly rows_written?: unknown;
}

interface ManagementQueryResult {
  readonly meta?: ManagementMeta;
  readonly results?: readonly Record<string, unknown>[];
  readonly success?: unknown;
}

interface ManagementEnvelope {
  readonly errors?: readonly { readonly code?: unknown }[];
  readonly result?: readonly ManagementQueryResult[];
  readonly success?: unknown;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function asLastRowId(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

function toResult<T = Record<string, unknown>>(
  entry: ManagementQueryResult,
  target: "local" | "remote",
  index: number,
): D1StatementResult<T> {
  if (entry.success !== true)
    throw new D1Error(
      `D1 ${target} statement ${String(index)} did not succeed`,
      { target, statementIndex: index },
    );
  const rows = (
    Array.isArray(entry.results) ? entry.results : []
  ) as readonly T[];
  return {
    rows,
    changes: asCount(entry.meta?.changes),
    lastRowId: asLastRowId(entry.meta?.last_row_id),
    rowsRead: asCount(entry.meta?.rows_read),
    rowsWritten: asCount(entry.meta?.rows_written),
  };
}

function sanitizeHeader(value: string | null): string {
  return (value ?? "").replace(/\p{Cc}/gu, " ").slice(0, 200);
}

async function readBounded(
  response: Response,
  maximum: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new D1Error("D1 remote transport returned an empty body", {
      target: "remote",
      status: response.status,
    });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum)
        throw new D1Error("D1 remote response exceeds the size limit", {
          target: "remote",
          status: response.status,
        });
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function errorCodes(
  errors: readonly { readonly code?: unknown }[] | undefined,
): string {
  const codes = (errors ?? [])
    .map((entry) => entry.code)
    .filter((code): code is number => typeof code === "number");
  return codes.length > 0
    ? codes.map((code) => String(code)).join(",")
    : "none";
}

function unexpectedShape(status: number, statementCount: number): D1Error {
  return new D1Error(
    `D1 remote transport returned HTTP ${String(status)} with an unexpected response shape for ${String(statementCount)} statement(s)`,
    { target: "remote", status },
  );
}

/** Create an adapter over the Cloudflare D1 management query API. */
export function createRemoteD1(config: RemoteD1Config): D1Adapter {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  const batch = async (
    statements: readonly D1Statement[],
  ): Promise<D1StatementResult<Record<string, unknown>>[]> => {
    if (statements.length === 0) return [];
    return executeRemote(endpoint, config.token, statements);
  };
  return {
    target: "remote",
    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly D1Value[] = [],
    ): Promise<D1StatementResult<T>> {
      const results = await batch([{ sql, params }]);
      const first = results[0];
      if (!first)
        throw new D1Error("D1 remote transport returned no result", {
          target: "remote",
        });
      return first as D1StatementResult<T>;
    },
    batch,
  };
}

/**
 * Serialize bindings for the management API. Numbers, strings and null stay
 * native; booleans normalize to `0`/`1`, matching the Worker binding's own
 * boolean-to-INTEGER conversion.
 */
function toRemoteParams(
  params: readonly D1Value[],
): (string | number | null)[] {
  return params.map((value) =>
    typeof value === "boolean" ? (value ? 1 : 0) : value,
  );
}

async function executeRemote(
  endpoint: string,
  token: string,
  statements: readonly D1Statement[],
): Promise<D1StatementResult<Record<string, unknown>>[]> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        statements.length === 1
          ? {
              sql: statements[0]?.sql,
              params: toRemoteParams(statements[0]?.params ?? []),
            }
          : {
              batch: statements.map((statement) => ({
                sql: statement.sql,
                params: toRemoteParams(statement.params ?? []),
              })),
            },
      ),
      redirect: "error",
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
  } catch {
    throw new D1Error(
      `D1 remote transport request failed for ${String(statements.length)} statement(s)`,
      { target: "remote" },
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const metadata = ["content-type", "cf-ray"]
      .map(
        (name) =>
          `${name}=${JSON.stringify(sanitizeHeader(response.headers.get(name)))}`,
      )
      .join(" ");
    throw new D1Error(
      `D1 remote transport failed: HTTP ${String(response.status)} ${metadata}`,
      { target: "remote", status: response.status },
    );
  }
  const type = response.headers.get("Content-Type")?.split(";")[0]?.trim();
  if (type !== "application/json") {
    await response.body?.cancel().catch(() => {});
    throw new D1Error(
      `D1 remote transport failed: HTTP ${String(response.status)} did not return JSON`,
      { target: "remote", status: response.status },
    );
  }
  let envelope: ManagementEnvelope;
  try {
    envelope = JSON.parse(
      await readBounded(response, 64 * 1024 * 1024),
    ) as ManagementEnvelope;
  } catch (error) {
    if (error instanceof D1Error) throw error;
    throw new D1Error("D1 remote transport returned invalid JSON", {
      target: "remote",
      status: response.status,
    });
  }
  if (envelope.success !== true || !Array.isArray(envelope.result))
    throw new D1Error(
      `D1 remote transport failed: success=false error_codes=${errorCodes(envelope.errors)} for ${String(statements.length)} statement(s)`,
      { target: "remote", status: response.status },
    );
  if (envelope.result.length !== statements.length)
    throw unexpectedShape(response.status, statements.length);
  return envelope.result.map((entry, index) =>
    toResult<Record<string, unknown>>(entry, "remote", index),
  );
}

/** Options for {@link createLocalD1}. */
export interface LocalD1Options {
  /** D1 binding name in wrangler.jsonc. Defaults to `"DB"`. */
  readonly binding?: string;
  /** Checkout directory whose `.wrangler` state backs local D1. */
  readonly cwd?: string;
}

function runWrangler(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
  }>();
  execFile(
    "pnpm",
    ["exec", "wrangler", ...args],
    { cwd, timeout: REMOTE_TIMEOUT_MS, maxBuffer: 128 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        reject(
          new D1Error("D1 local wrangler execution failed", {
            target: "local",
          }),
        );
        return;
      }
      resolve({ stdout, stderr });
    },
  );
  return promise;
}

function parseLocalOutput(stdout: string): ManagementQueryResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new D1Error("D1 local transport returned invalid JSON", {
      target: "local",
    });
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null)
      throw new D1Error(
        `D1 local statement ${String(index)} returned an unexpected shape`,
        { target: "local", statementIndex: index },
      );
    const record = entry as {
      readonly meta?: ManagementMeta;
      readonly results?: unknown;
      readonly success?: unknown;
    };
    if (!Array.isArray(record.results))
      throw new D1Error(
        `D1 local statement ${String(index)} returned an unexpected shape`,
        { target: "local", statementIndex: index },
      );
    return {
      meta: record.meta,
      results: record.results as readonly Record<string, unknown>[],
      success: record.success,
    };
  });
}

/**
 * Create an adapter over Wrangler local D1. Executes the checkout's real
 * local database through `pnpm exec wrangler d1 execute` with rendered
 * literals in an ignored temporary SQL file that is always removed.
 */
export function createLocalD1(options: LocalD1Options = {}): D1Adapter {
  const binding = options.binding ?? "DB";
  const cwd = options.cwd ?? process.cwd();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding))
    throw new D1Error("D1 local binding name is invalid", { target: "local" });
  const batch = async (
    statements: readonly D1Statement[],
  ): Promise<D1StatementResult<Record<string, unknown>>[]> => {
    if (statements.length === 0) return [];
    // Local Wrangler omits changes metadata. SQLite counters recover it without
    // changing the caller's changes() state, including between CAS statements.
    const rendered = statements.flatMap((statement) => [
      "SELECT total_changes() AS __molu_total",
      renderStatement(statement),
      "SELECT total_changes() AS __molu_total, changes() AS __molu_changes, last_insert_rowid() AS __molu_rowid",
    ]);
    const directory = await mkdtemp(join(tmpdir(), "molu-d1-"));
    const file = join(directory, "statements.sql");
    try {
      await writeFile(file, `${rendered.join(";\n")};\n`, "utf8");
      const { stdout } = await runWrangler(
        ["d1", "execute", binding, "--local", "--json", "--file", file],
        cwd,
      );
      const entries = parseLocalOutput(stdout);
      if (entries.length !== statements.length * 3)
        throw new D1Error(
          `D1 local transport returned an unexpected result count for ${String(statements.length)} statements`,
          { target: "local" },
        );
      return statements.map((_, index) => {
        const before = toResult(entries[index * 3]!, "local", index);
        const result = toResult(entries[index * 3 + 1]!, "local", index);
        const after = toResult(entries[index * 3 + 2]!, "local", index);
        const initial = before.rows[0]?.__molu_total;
        const final = after.rows[0];
        const total = final?.__molu_total;
        const changed = final?.__molu_changes;
        if (
          typeof initial !== "number" ||
          !Number.isSafeInteger(initial) ||
          typeof total !== "number" ||
          !Number.isSafeInteger(total) ||
          total < initial ||
          typeof changed !== "number" ||
          !Number.isSafeInteger(changed) ||
          changed < 0
        )
          throw new D1Error(
            "D1 local transport returned invalid SQLite counters",
            { target: "local", statementIndex: index },
          );
        return {
          ...result,
          changes: total === initial ? 0 : changed,
          rowsWritten: total - initial,
          lastRowId: asLastRowId(final?.__molu_rowid),
        };
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  return {
    target: "local",
    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly D1Value[] = [],
    ): Promise<D1StatementResult<T>> {
      const results = await batch([{ sql, params }]);
      const first = results[0];
      if (!first)
        throw new D1Error("D1 local transport returned no result", {
          target: "local",
        });
      return first as D1StatementResult<T>;
    },
    batch,
  };
}
