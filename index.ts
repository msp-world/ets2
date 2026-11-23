import { MSPNode, installShutdownHooks, mspOptionsFromEnv } from "../shared/msp.ts";
import { Ets2World } from "./world.ts";

export async function startEts2Node(): Promise<{ node: MSPNode; world: Ets2World }> {
  const node = new MSPNode(process.env.ETS2_NODE_ID || "ets2", mspOptionsFromEnv("ETS2"));
  const world = new Ets2World({
    telemetryUrl: process.env.ETS2_TELEMETRY_URL || "http://127.0.0.1:25555/api/ets2/telemetry",
  });
  world.attach(node);
  const ep = await node.start();
  world.start();
  console.log(`[ets2] MSP node "${node.nodeId}" listening on ${ep.host}:${ep.port}`);
  return { node, world };
}

if (import.meta.main) {
  const { node, world } = await startEts2Node();
  installShutdownHooks(() => {
    world.stop();
    node.stop();
  });
}
