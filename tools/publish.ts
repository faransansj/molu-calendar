import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "../src/lib/admin/images.ts";
import {
  PUBLICATION_ID,
  type PublicationSnapshot,
  type PublicationState,
} from "../src/lib/admin/publication.ts";
import {
  IMAGE_DIRECTORY,
  SNAPSHOT_PATH,
  readSnapshot,
  referencedImages,
  validateImage,
  validatePublication,
  validateSnapshot,
  writeJsonAtomic,
} from "./build-publication.ts";

const command = process.argv[2];
if (!["prepare", "complete", "fail"].includes(command ?? ""))
  throw new Error("Usage: node tools/publish.ts prepare|complete|fail");
const source = process.env.PUBLICATION_SOURCE ?? "staged";
if (source !== "staged" && source !== "deployed")
  throw new Error("PUBLICATION_SOURCE must be staged or deployed");
const requestedId = process.env.PUBLICATION_ID || null;
if (requestedId && !PUBLICATION_ID.test(requestedId))
  throw new Error("Invalid PUBLICATION_ID");
if (source === "deployed" && requestedId)
  throw new Error("Deployed source cannot select a staged publication");

const originValue = process.env.ADMIN_ORIGIN;
const token = process.env.PUBLISH_TOKEN;
if (!originValue || !token)
  throw new Error("ADMIN_ORIGIN and PUBLISH_TOKEN are required");
const origin = new URL(originValue);
if (
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  (origin.protocol !== "https:" &&
    !(
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    ))
)
  throw new Error(
    "ADMIN_ORIGIN must be an HTTPS origin (HTTP loopback allowed)",
  );

async function request(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const metadata = ["content-type", "cf-ray", "cf-mitigated"]
      .map((name) => {
        const value = (response.headers.get(name) ?? "")
          .replace(/\p{Cc}/gu, " ")
          .slice(0, 200);
        return `${name}=${JSON.stringify(value)}`;
      })
      .join(" ");
    throw new Error(
      `Publication API ${method} ${path}: HTTP ${response.status} ${metadata}`,
    );
  }
  return response;
}

async function responseBytes(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Publication API returned an empty body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("Publication response is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
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
  return bytes;
}

async function responseJson(response: Response): Promise<unknown> {
  const type = response.headers.get("Content-Type")?.split(";")[0]?.trim();
  if (type !== "application/json")
    throw new Error("Publication API did not return JSON");
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await responseBytes(response, 8 * 1024 * 1024),
    ),
  );
}

async function setStatus(id: string, state: PublicationState): Promise<void> {
  const value = z
    .strictObject({ publication: z.unknown() })
    .parse(
      await responseJson(
        await request(`/api/publish/releases/${id}/status`, "PUT", { state }),
      ),
    );
  const publication = validatePublication(value.publication);
  if (publication.id !== id || publication.state !== state)
    throw new Error("Publication status response did not match the request");
}

async function prepare(): Promise<void> {
  let failureId = source === "staged" ? requestedId : null;
  let temporary: string | null = null;
  let outputWritten = false;
  async function recordId(id: string): Promise<void> {
    failureId = id;
    if (!outputWritten && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `publication_id=${id}\n`);
      outputWritten = true;
    }
  }
  try {
    // Record a caller-selected release before fetching so failed downloads can
    // still be marked failed by the workflow, without trusting arbitrary text.
    if (failureId) await recordId(failureId);
    let input: unknown;
    if (source === "deployed") {
      const result = z
        .strictObject({ snapshot: z.unknown() })
        .parse(await responseJson(await request("/api/publish/deployed")));
      input = result.snapshot;
      if (input === null) {
        await writeJsonAtomic(SNAPSHOT_PATH, null);
        return;
      }
    } else {
      input = await responseJson(
        requestedId
          ? await request(`/api/publish/releases/${requestedId}`)
          : await request("/api/publish/snapshot", "POST", {}),
      );
      // Capture only a validated UUID before validating the remaining payload.
      const identity = z
        .object({
          publication: z.object({ id: z.string().regex(PUBLICATION_ID) }),
        })
        .parse(input).publication.id;
      if (requestedId && identity !== requestedId)
        throw new Error("Publication snapshot ID mismatch");
      await recordId(identity);
    }
    const snapshot: PublicationSnapshot = validateSnapshot(input);
    if (
      source === "deployed"
        ? snapshot.publication.state !== "published"
        : !["queued", "building"].includes(snapshot.publication.state)
    )
      throw new Error("Publication is not in a deployable state");
    await mkdir(".publication", { recursive: true });
    temporary = await mkdtemp(".publication/download-");
    const images = referencedImages(snapshot);
    for (const name of images) {
      const bytes = await responseBytes(
        await request(
          `/api/publish/releases/${snapshot.publication.id}/images/${name}`,
        ),
        MAX_UPLOAD_BYTES,
      );
      validateImage(name, bytes);
      await writeFile(`${temporary}/${name}`, bytes, { flag: "wx" });
    }
    await mkdir(IMAGE_DIRECTORY, { recursive: true });
    // Upload names are immutable UUIDs. Never replace existing bytes under a
    // name used by the last good snapshot, even if a bad response reuses it.
    for (const name of images) {
      const path = `${IMAGE_DIRECTORY}/${name}`;
      let existing: Buffer | null = null;
      try {
        existing = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing) {
        if (!existing.equals(await readFile(`${temporary}/${name}`)))
          throw new Error(`Immutable publication image changed: ${name}`);
      } else {
        await rename(`${temporary}/${name}`, path);
      }
    }
    if (source === "staged")
      await setStatus(snapshot.publication.id, "building");
    // The snapshot is the commit point: it changes only after every referenced
    // image is validated and installed. Failed prepares preserve the old input.
    await writeJsonAtomic(SNAPSHOT_PATH, snapshot);
  } catch (error) {
    if (failureId) {
      try {
        await setStatus(failureId, "failed");
      } catch {
        console.error(`Could not mark publication ${failureId} failed.`);
      }
    }
    throw error;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (command === "prepare") {
  await prepare();
} else if (source !== "deployed") {
  const id = requestedId ?? (await readSnapshot())?.publication.id;
  if (!id)
    throw new Error("No publication is available for the status callback");
  await setStatus(id, command === "complete" ? "published" : "failed");
}
