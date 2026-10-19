import { postmarkConformance } from "../../conformance/fixtures/postmark";
import { runConformance } from "../../conformance/suite";
import { postmarkAdapter } from "./index";

runConformance(postmarkAdapter, postmarkConformance);
