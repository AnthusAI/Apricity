import { createEncoderService, type EncoderRequest } from "./encoder";

const worker = self as DedicatedWorkerGlobalScope;
const service = createEncoderService({ post: (event) => worker.postMessage(event) });

worker.addEventListener("message", (event: MessageEvent<EncoderRequest>) => {
  void service.handle(event.data);
});
