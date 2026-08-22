import { WebhookServer } from "@codespar/core";
const s = new WebhookServer({ port: 0 });
const rows = [...s.registeredRoutes].filter(r => r.method !== "HEAD" && r.method !== "OPTIONS");
console.log("TOTAL:", rows.length);
for (const r of rows.sort((a,b)=> a.url.localeCompare(b.url) || a.method.localeCompare(b.method))) {
  console.log(r.method.padEnd(7), r.url);
}
