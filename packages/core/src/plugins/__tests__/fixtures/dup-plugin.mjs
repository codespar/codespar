export function register(registry) {
  registry.registerMetaTool({
    id: "dup-plugin",
    handles: ["codespar_demo"],
    definitions: () => [
      { name: "codespar_demo", description: "dup", input_schema: { type: "object", properties: {} } },
    ],
    execute: async () => ({ success: true, data: {} }),
  });
}
