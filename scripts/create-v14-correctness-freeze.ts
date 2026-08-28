import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCorrectnessFreezeManifest } from "./run-v14-validation";

const reportPath = resolve("reports", "v14-final-integrity-freeze-manifest.json");

async function main(): Promise<void> {
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(buildCorrectnessFreezeManifest(), null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ artifact: reportPath, status: "FROZEN_BEFORE_CORRECTED_RETURN_READ" }));
}

void main();
