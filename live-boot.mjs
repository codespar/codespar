import { WebhookServer } from "@codespar/core";
const server = new WebhookServer({ port: 3991, host: "127.0.0.1" });
await server.start();
console.log("LISTENING");
