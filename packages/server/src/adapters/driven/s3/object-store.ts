import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type GetObjectCommandInput,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  StorageError,
  type ByteRange,
  type ContentRange,
  type ObjectBody,
  type ObjectKey,
  type ObjectStore,
  type StoredObject,
} from "../../../application/ports/object-store.js";
import { Readable } from "node:stream";

/*
 * `ObjectStore` over an S3-compatible store — api-sketch §9.7, brief §10.1.
 * Named for the protocol, not the deployment: SeaweedFS in compose, Hetzner
 * in production (brief §12). The port's contract is documented there.
 */
/**
 * Time to the store's response headers on `head`, `get`, `remove` and the
 * boot check, per attempt (three attempts by the SDK's default retry). It
 * throws only because createS3Client sets `throwOnRequestTimeout`; without
 * that the SDK logs a warning and waits forever. Not on `put`: its headers
 * come after the upload body, so its bound is §9.7's deadline, not this.
 */
export const STORE_REQUEST_TIMEOUT_MS = 10_000;

class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly bounded: { requestTimeout: number };
  constructor(client: S3Client, bucket: string, requestTimeoutMs: number) {
    this.client = client;
    this.bucket = bucket;
    this.bounded = { requestTimeout: requestTimeoutMs };
  }

  async put(key: ObjectKey, body: Readable, length: number): Promise<void> {
    try {
      const command = new PutObjectCommand({
        Key: key,
        Bucket: this.bucket,
        Body: body,
        ContentLength: length,
        ContentType: "application/octet-stream",
      });
      await this.client.send(command);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("UNAVAILABLE", {
        cause: new Error(
          `PUT ${key} failed (${nameOf(error)} ${statusOf(error)})`,
        ),
      });
    }
  }

  async head(key: ObjectKey): Promise<StoredObject | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Key: key, Bucket: this.bucket }),
        this.bounded,
      );
      // A 200 without one is a store that cannot answer the question §9.7
      // asks, which is not the same as the object being absent.
      if (typeof response.ContentLength !== "number") {
        throw new StorageError("UNAVAILABLE", {
          cause: new Error(`HEAD ${key}: 200 with no Content-Length`),
        });
      }
      return { length: response.ContentLength };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      /*
       * 404 AND NOTHING ELSE becomes `null`. A 403 in particular must not:
       * on a bucket with narrowed permissions a missing object answers 403
       * rather than 404, and reading that as absent would leave the row
       * `processing` forever instead of surfacing the misconfiguration.
       * Stalling is the recoverable direction, so this errs towards throwing.
       */
      if (statusOf(error) === 404) return null;
      throw new StorageError("UNAVAILABLE", {
        cause: new Error(
          `HEAD ${key} failed (${nameOf(error)} ${statusOf(error)})`,
        ),
      });
    }
  }

  async get(key: ObjectKey, range?: ByteRange): Promise<ObjectBody> {
    const input: GetObjectCommandInput = {
      Key: key,
      Bucket: this.bucket,
    };

    if (range) {
      input.Range = `bytes=${range.start}-${range.end ?? ""}`;
    }
    try {
      // Bounds the wait for headers only; the body that follows is not
      // (composition-root.ts, createS3Client, says why).
      const response = await this.client.send(
        new GetObjectCommand(input),
        this.bounded,
      );

      const body = response.Body;
      if (!(body instanceof Readable)) {
        throw new StorageError("UNAVAILABLE", {
          cause: new Error(`GET ${key}: 2xx with no readable body`),
        });
      }

      if (typeof response.ContentLength !== "number") {
        body.destroy();
        throw new StorageError("UNAVAILABLE", {
          cause: new Error(`GET ${key}: 2xx with no Content-Length`),
        });
      }

      if (range === undefined)
        return { body, contentLength: response.ContentLength };

      const contentRange = parseContentRange(response.ContentRange);

      if (contentRange === null || contentRange.start !== range.start) {
        body.destroy();
        throw new StorageError("UNAVAILABLE", {
          cause: new Error(`GET ${key}: 2xx with an unusable Content-Range`),
        });
      }

      return {
        body,
        contentLength: response.ContentLength,
        contentRange,
      };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (statusOf(error) === 404) throw new StorageError("NOT_FOUND");
      if (statusOf(error) === 416) {
        const size = await this.head(key);
        if (!size) throw new StorageError("NOT_FOUND");
        throw new StorageError("INVALID_RANGE", { objectSize: size.length });
      }
      throw new StorageError("UNAVAILABLE", {
        cause: new Error(
          `GET ${key} failed (${nameOf(error)} ${statusOf(error)})`,
        ),
      });
    }
  }

  async remove(key: ObjectKey): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Key: key, Bucket: this.bucket }),
        this.bounded,
      );
    } catch (error) {
      if (statusOf(error) === 404) return;
      throw new StorageError("UNAVAILABLE", {
        cause: new Error(
          `DELETE ${key} failed (${nameOf(error)} ${statusOf(error)})`,
        ),
      });
    }
  }
}

export function createObjectStore(
  client: S3Client,
  bucket: string,
  requestTimeoutMs = STORE_REQUEST_TIMEOUT_MS,
): ObjectStore {
  return new S3ObjectStore(client, bucket, requestTimeoutMs);
}

/**
 * Boot check, called by index.ts before it listens — brief §6 #17's rule
 * applied to the store. A wrong `DATABASE_URL` fails loudly on the first
 * query; a wrong bucket fails nowhere: writes land somewhere nobody reads and
 * `head` answers absent forever, which §9.7 renders as an upload stuck at
 * `processing`. This is the only thing that makes that noisy — and only until
 * something writes to the wrong name: SeaweedFS creates a bucket on its first
 * `PutObject` (measured), after which this check passes. AWS does not;
 * Hetzner is unverified.
 *
 * It also lets `head`'s 404 mean one thing afterwards. A `HEAD` carries no
 * response body, so a missing bucket and a missing object are the same status
 * — the bucket is ruled out here so the ambiguity never reaches a request.
 */
export async function verifyBucket(
  client: S3Client,
  bucket: string,
  endpoint: string,
  requestTimeoutMs = STORE_REQUEST_TIMEOUT_MS,
): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), {
      requestTimeout: requestTimeoutMs,
    });
  } catch (error) {
    // The SDK's own message names neither, because a HEAD has no body to read
    // a code from — and those are the two things an operator needs here. Both
    // are configuration, never request content.
    throw new StorageError("UNAVAILABLE", {
      cause: new Error(
        `cannot reach bucket "${bucket}" at ${endpoint} (${nameOf(error)} ${statusOf(error)})`,
      ),
    });
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata;
  return typeof metadata?.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// `bytes X-Y/Z` → numbers, or null if malformed or impossible. The relay
// re-renders these values (§11.2), so it checks they describe a real range.
function parseContentRange(header: string | undefined): ContentRange | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header ?? "");
  if (!match) return null;

  const [start, end, size] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  if (![start, end, size].every(Number.isSafeInteger)) return null;
  if (start > end || end >= size) return null;

  return { start, end, size };
}
