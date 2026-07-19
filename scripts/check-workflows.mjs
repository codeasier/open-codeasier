import console from "node:console";
import process from "node:process";

import { main } from "./generate-workflows.mjs";

main([...process.argv.slice(2), "--check"]).catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
