import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createSemanticRuntime } from "../../semantic/runtime";

const runtime = createSemanticRuntime();
export const handler = async (event: APIGatewayProxyEventV2) => runtime.handle(event);
