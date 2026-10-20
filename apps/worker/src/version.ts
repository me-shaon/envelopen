// The Envelopen version. The root package.json is the only source. Wrangler bundles the
// value at build time. The named import keeps the rest of package.json out of the bundle.
import { version } from "../../../package.json";

export const ENVELOPEN_VERSION: string = version;
