import { AwsClient } from "aws4fetch";
import type { S3Destination } from "./model";

// Where backup files go (U4): R2 always, and an optional S3-compatible copy.
//
// The S3 copy uses one signed PUT per object (SigV4 through aws4fetch). Multipart
// uploads are not needed: a chunk holds at most CHUNK_ROWS rows and at most
// MAX_CHUNK_BYTES of NDJSON (run.ts), far below the 5 GB limit of one PUT. The requests
// use path-style URLs (`<endpoint>/<bucket>/<key>`), which AWS, R2, MinIO, Backblaze,
// and Wasabi all accept. They go through the outbound fetch, so the end-to-end tests
// can answer them with a mock.

export interface BackupStore {
  readonly name: "r2" | "s3";
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Deletes the objects. A missing object is not an error. */
  delete(keys: readonly string[]): Promise<void>;
}

/** The R2 bucket of the deployment. */
export function r2Store(bucket: R2Bucket): BackupStore {
  return {
    name: "r2",
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    async delete(keys) {
      for (let start = 0; start < keys.length; start += 1000) {
        await bucket.delete(keys.slice(start, start + 1000) as string[]);
      }
    },
  };
}

/** Lists every object key under a prefix of the R2 bucket. */
export async function listR2Keys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((object) => object.key));
    if (!page.truncated) return keys;
    cursor = page.cursor;
  }
}

/** Thrown for a failed S3 request. The message never holds the credentials. */
export class S3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3Error";
  }
}

function objectUrl(destination: S3Destination, key: string): string {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${destination.endpoint}/${encodeURIComponent(destination.bucket)}/${path}`;
}

async function failure(response: Response, action: string): Promise<S3Error> {
  let detail = "";
  try {
    const text = await response.text();
    detail = /<Code>([^<]{1,100})<\/Code>/.exec(text)?.[1] ?? "";
  } catch {
    // The body is only a hint.
  }
  return new S3Error(
    `The S3 ${action} failed with HTTP ${response.status}${detail ? ` (${detail})` : ""}.`,
  );
}

/** An S3-compatible store. `fetcher` is the outbound fetch of the deployment. */
export function s3Store(destination: S3Destination, fetcher: typeof fetch): BackupStore {
  const client = new AwsClient({
    accessKeyId: destination.accessKeyId,
    secretAccessKey: destination.secretAccessKey,
    region: destination.region,
    service: "s3",
    retries: 0,
  });
  const send = async (request: Request, action: string) => {
    let response: Response;
    try {
      response = await fetcher(request);
    } catch (error) {
      throw new S3Error(
        `The S3 ${action} did not reach ${new URL(destination.endpoint).host}: ${
          error instanceof Error ? error.message.slice(0, 200) : "network error"
        }.`,
      );
    }
    if (!response.ok && !(action === "delete" && response.status === 404)) {
      throw await failure(response, action);
    }
    await response.body?.cancel();
  };
  return {
    name: "s3",
    async put(key, body, contentType) {
      const request = await client.sign(objectUrl(destination, key), {
        method: "PUT",
        headers: { "content-type": contentType },
        body: body as Uint8Array<ArrayBuffer>,
      });
      await send(request, "upload");
    },
    async delete(keys) {
      for (const key of keys) {
        await send(await client.sign(objectUrl(destination, key), { method: "DELETE" }), "delete");
      }
    },
  };
}
