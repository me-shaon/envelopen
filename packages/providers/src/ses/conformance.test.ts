import { sesConformance } from "../../conformance/fixtures/ses";
import { runConformance } from "../../conformance/suite";
import { sesAdapter } from "./index";

runConformance(sesAdapter, sesConformance);
