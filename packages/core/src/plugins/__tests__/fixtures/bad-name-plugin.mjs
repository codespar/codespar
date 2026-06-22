export default function register(registry) {
  registry.registerMetaTool({
    id: "bad-name-plugin",
    handles: ["bad__name"],
    definitions: () => [],
    execute: async () => ({ success: true, data: {} }),
  });
}
