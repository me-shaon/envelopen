import { toSendConformance } from "../../conformance/fixtures/tosend";
import { runConformance } from "../../conformance/suite";
import { toSendAdapter } from "./index";

runConformance(toSendAdapter, toSendConformance);
