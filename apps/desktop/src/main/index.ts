import { bootstrapDesktop, reportBootstrapFailure } from "./bootstrap";

void bootstrapDesktop().catch(reportBootstrapFailure);
