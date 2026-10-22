import { mailgunConformance } from "../../conformance/fixtures/mailgun";
import { runConformance } from "../../conformance/suite";
import { mailgunAdapter } from "./index";

runConformance(mailgunAdapter, mailgunConformance);
