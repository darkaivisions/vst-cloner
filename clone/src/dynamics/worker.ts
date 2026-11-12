// Worker thread for the compressor fit: the fit is one long synchronous computation, so it runs here to keep
// the caller responsive (progress, time limits) and to be stoppable at any moment.
import { parentPort, workerData } from "node:worker_threads";
import { readProfile } from "@vst-cloner/profile";
import { fitDynamics } from "./fit.ts";

const profile = await readProfile((workerData as { profilePath: string }).profilePath);
const model = fitDynamics(profile, (done, total, label) => parentPort!.postMessage({ progress: { done, total, label } }));
parentPort!.postMessage({ model });
