import type { Principal } from "@envelopen/core";
import type { DbConnection } from "@envelopen/db";

/** Hono environment of the `/api` router. */
export interface ApiEnv {
  Bindings: Env;
  Variables: {
    db: DbConnection;
    principal: Principal;
  };
}
