/** A resolution target only: entrypoint tests must explicitly mock SDK calls. */
export function definePluginEntry(): never {
  throw new Error("Mock definePluginEntry in entrypoint tests");
}

export function resolveApprovalOverGateway(): never {
  throw new Error("Mock resolveApprovalOverGateway in entrypoint tests");
}
