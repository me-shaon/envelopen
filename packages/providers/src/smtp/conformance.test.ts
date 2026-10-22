import { smtpConformance } from "../../conformance/fixtures/smtp";
import { runConformance } from "../../conformance/suite";
import { smtpAdapter } from "./index";

// The SMTP adapter with the Brevo preset against the in-process mock SMTP server.
runConformance(smtpAdapter, smtpConformance);
