declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** A second deployment that the restore tests write into. */
    RESTORE_DB: D1Database;
    BUCKET: R2Bucket;
    // Defined in vitest.config.ts.
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

// vitest.config.ts runs in Node.js, where import.meta.url is set. This package has
// Workers types only, so declare it here instead of adding Node.js types.
interface ImportMeta {
  readonly url: string;
}
