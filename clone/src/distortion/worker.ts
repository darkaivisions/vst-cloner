// Worker thread for the distortion fit: receives the measurement input once, then fits jobs on request.
import { parentPort, workerData } from "node:worker_threads";
import { fitDistortionRender, fitSweepPoint, packDistortion, type DistortionInput, type DistortionJob, type JobResult } from "./fit.ts";

const input = workerData as DistortionInput;
parentPort!.on("message", (job: DistortionJob) => {
  let result: JobResult;
  if (job.kind === "base") {
    const fit = fitDistortionRender(job.observation, input, job.start);
    result = { x: packDistortion(fit.params), error: fit.errors.total };
  } else {
    result = fitSweepPoint(job.observation, input, job.x0, job.groups);
  }
  parentPort!.postMessage(result);
});
