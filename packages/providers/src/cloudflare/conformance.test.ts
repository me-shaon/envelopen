import { cloudflareConformance } from "../../conformance/fixtures/cloudflare";
import { runConformance } from "../../conformance/suite";
import { cloudflareAdapter } from "./index";

runConformance(cloudflareAdapter, cloudflareConformance);
