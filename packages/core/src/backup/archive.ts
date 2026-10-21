import { BackupCryptoError } from "./crypto";
import { backupPrefix, MANIFEST_KEY, type Manifest, type ManifestChunk } from "./format";

// The single-file backup archive (U5, R3). A download gives one file, and the first-run
// screen of another deployment takes the same file. Layout:
//
//   bytes 0..7     the magic "ENVBAK01"
//   bytes 8..11    the manifest length N, unsigned 32-bit big-endian
//   bytes 12..     the manifest JSON, exactly as `manifest.json` in R2 (N bytes)
//   then           every chunk object in manifest order, back to back
//
// A chunk's offset follows from the lengths in the manifest (`bytes` of each chunk), so
// a restore reads one chunk with one ranged R2 read. The archive adds no protection of
// its own: the manifest tag covers the chunk list, each chunk has its SHA-256 in the
// manifest, and AES-GCM with the backup id and chunk index protects each chunk.

export const ARCHIVE_MAGIC = "ENVBAK01";
export const ARCHIVE_EXTENSION = ".envbak";
const HEADER_BYTES = 12;
/** A manifest larger than this is not a manifest of a backup that Envelopen made. */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
/** Uploaded archives wait here until the restore ends. */
export const RESTORE_UPLOAD_PREFIX = "restore-uploads/";

/** The 12-byte header before the manifest. */
export function archiveHeader(manifestLength: number): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  out.set(new TextEncoder().encode(ARCHIVE_MAGIC), 0);
  new DataView(out.buffer).setUint32(8, manifestLength);
  return out;
}

/** The manifest length from the header, or throws for a file that is not an archive. */
export function readArchiveHeader(bytes: Uint8Array): number {
  if (bytes.length < HEADER_BYTES) throw new BackupCryptoError("The file is not a backup.");
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== ARCHIVE_MAGIC) {
    throw new BackupCryptoError("The file is not an Envelopen backup (.envbak).");
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8);
  if (length < 2 || length > MAX_MANIFEST_BYTES) {
    throw new BackupCryptoError("The backup file has no valid manifest.");
  }
  return length;
}

/** Byte offsets of the chunks in an archive, by chunk index. */
export function chunkOffsets(manifest: Manifest, manifestLength: number): Map<number, number> {
  const offsets = new Map<number, number>();
  let offset = HEADER_BYTES + manifestLength;
  for (const chunk of [...manifest.chunks].sort((a, b) => a.index - b.index)) {
    offsets.set(chunk.index, offset);
    offset += chunk.bytes;
  }
  return offsets;
}

/** The archive size in bytes. */
export function archiveSize(manifest: Manifest, manifestLength: number): number {
  return HEADER_BYTES + manifestLength + manifest.chunks.reduce((sum, c) => sum + c.bytes, 0);
}

/** Parses manifest JSON loosely: the shape checks come with the tag check. */
export function parseManifest(bytes: Uint8Array): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BackupCryptoError("The backup manifest is not valid JSON.");
  }
  const manifest = parsed as Partial<Manifest> | null;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    typeof manifest.backupId !== "string" ||
    typeof manifest.schemaVersion !== "number" ||
    typeof manifest.createdAt !== "number" ||
    !Array.isArray(manifest.chunks) ||
    !Array.isArray(manifest.tables) ||
    typeof manifest.wrappedKey !== "object" ||
    typeof manifest.keyMaterial !== "object" ||
    typeof manifest.tag !== "string"
  ) {
    throw new BackupCryptoError("The backup manifest is not complete.");
  }
  return manifest as Manifest;
}

// Sources ------------------------------------------------------------------------------

/** Where a restore reads a backup from. */
export interface BackupSource {
  /** The manifest bytes, as the backup wrote them. */
  manifestBytes(): Promise<Uint8Array>;
  /** The encrypted bytes of one chunk. */
  chunk(chunk: ManifestChunk): Promise<Uint8Array>;
}

async function bytesOf(object: R2ObjectBody | null, what: string): Promise<Uint8Array> {
  if (!object) throw new BackupCryptoError(`The backup ${what} is missing.`);
  return new Uint8Array(await object.arrayBuffer());
}

/** A backup folder `backups/<backupId>/` in this deployment's R2 bucket. */
export function r2FolderSource(bucket: R2Bucket, backupId: string): BackupSource {
  const prefix = backupPrefix(backupId);
  return {
    manifestBytes: async () => bytesOf(await bucket.get(prefix + MANIFEST_KEY), "manifest"),
    chunk: async (chunk) => bytesOf(await bucket.get(prefix + chunk.key), `chunk ${chunk.index}`),
  };
}

/** An archive file in R2, read with ranged reads. */
export function r2ArchiveSource(bucket: R2Bucket, key: string): BackupSource {
  let manifestLength: number | null = null;
  let offsets: Map<number, number> | null = null;
  const header = async () => {
    if (manifestLength === null) {
      const head = await bytesOf(
        await bucket.get(key, { range: { offset: 0, length: HEADER_BYTES } }),
        "file",
      );
      manifestLength = readArchiveHeader(head);
    }
    return manifestLength;
  };
  const manifestBytes = async () => {
    const length = await header();
    return bytesOf(await bucket.get(key, { range: { offset: HEADER_BYTES, length } }), "manifest");
  };
  return {
    manifestBytes,
    async chunk(chunk) {
      if (!offsets) {
        offsets = chunkOffsets(parseManifest(await manifestBytes()), await header());
      }
      return r2ArchiveChunkReader(bucket, key, offsets)(chunk);
    },
  };
}

/**
 * Like r2ArchiveSource, but with the chunk offsets from a manifest that the caller
 * already holds. A restore step uses it, so it reads only the chunk.
 */
export function r2ArchiveChunkReader(
  bucket: R2Bucket,
  key: string,
  offsets: ReadonlyMap<number, number>,
): (chunk: ManifestChunk) => Promise<Uint8Array> {
  return async (chunk) => {
    const offset = offsets.get(chunk.index);
    if (offset === undefined) throw new BackupCryptoError(`No chunk ${chunk.index}.`);
    const bytes = await bytesOf(
      await bucket.get(key, { range: { offset, length: chunk.bytes } }),
      `chunk ${chunk.index}`,
    );
    if (bytes.length !== chunk.bytes) {
      throw new BackupCryptoError(`The backup file ends inside chunk ${chunk.index}.`);
    }
    return bytes;
  };
}

// Download -----------------------------------------------------------------------------

/** The R2 key that a signed download link of a backup archive carries. */
export function archiveLinkKey(backupId: string): string {
  return `${backupPrefix(backupId)}archive${ARCHIVE_EXTENSION}`;
}

/** The backup id of an archive link key, or null for any other key. */
export function backupIdOfLinkKey(key: string): string | null {
  const match = /^backups\/([0-9a-f-]{36})\/archive\.envbak$/.exec(key);
  return match?.[1] ?? null;
}

/**
 * Streams the archive of a backup from its R2 objects: the header, the manifest, then
 * each chunk. It reads one object at a time, so the Worker holds at most one chunk.
 * Returns null when the backup has no manifest.
 */
export async function streamBackupArchive(
  bucket: R2Bucket,
  backupId: string,
): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
  const prefix = backupPrefix(backupId);
  const manifestObject = await bucket.get(prefix + MANIFEST_KEY);
  if (!manifestObject) return null;
  const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
  const manifest = parseManifest(manifestBytes);
  const size = archiveSize(manifest, manifestBytes.length);
  const chunks = [...manifest.chunks].sort((a, b) => a.index - b.index);
  let next = -1;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next === -1) {
        const head = archiveHeader(manifestBytes.length);
        const first = new Uint8Array(head.length + manifestBytes.length);
        first.set(head, 0);
        first.set(manifestBytes, head.length);
        controller.enqueue(first);
        next = 0;
        return;
      }
      const chunk = chunks[next];
      if (!chunk) {
        controller.close();
        return;
      }
      next += 1;
      const object = await bucket.get(prefix + chunk.key);
      if (!object || object.size !== chunk.bytes) {
        controller.error(new BackupCryptoError(`The backup chunk ${chunk.index} is missing.`));
        return;
      }
      controller.enqueue(new Uint8Array(await object.arrayBuffer()));
    },
  });
  return { body, size };
}
