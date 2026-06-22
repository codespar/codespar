export default function register(registry) {
  registry.registerMetaTool({
    id: "good-plugin",
    handles: ["codespar_demo"],
    definitions: () => [
      { name: "codespar_demo", description: "demo", input_schema: { type: "object", properties: {} } },
    ],
    execute: async () => ({ success: true, data: {} }),
  });
}
