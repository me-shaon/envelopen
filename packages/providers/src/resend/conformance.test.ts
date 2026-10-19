import { resendConformance } from "../../conformance/fixtures/resend";
import { runConformance } from "../../conformance/suite";
import { resendAdapter } from "./index";

runConformance(resendAdapter, resendConformance);
