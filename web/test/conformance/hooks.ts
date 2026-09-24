import { BeforeAll } from "@cucumber/cucumber";
import { loadAmplifyConfig } from "./config.js";

BeforeAll(async () => {
  await loadAmplifyConfig();
});
