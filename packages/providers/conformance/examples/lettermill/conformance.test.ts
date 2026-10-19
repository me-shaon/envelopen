import { runConformance } from "../../suite";
import { lettermillAdapter } from "./adapter";
import { lettermillConformance } from "./fixtures";

runConformance(lettermillAdapter, lettermillConformance);
