import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";

test("authenticated live catalog refresh merges only proven Pro availability", async () => {
  const prior = process.env.CODEX_CHATGPT_WEB_HOME;
  const root = mkdtempSync(join(tmpdir(), "pro-catalog-")); process.env.CODEX_CHATGPT_WEB_HOME = root;
  const config = { ...defaultConfig("browser-only"), port: 0, proAvailable: false, proSelectable: false };
  const server = startServer(config);
  config.port = server.port!;
  saveConfig(config);
  const request = (body: unknown, auth = true) => fetch(`http://127.0.0.1:${server.port}/admin/pro-available`, {
    method: "POST", headers: { ...(auth ? {authorization:`Bearer ${config.controlToken}`} : {}), "content-type":"application/json" }, body: JSON.stringify(body),
  });
  try {
    expect((await request({proSelectable:true},false)).status).toBe(401);
    expect((await request({proSelectable:false})).status).toBe(400);
    expect(loadConfig().proAvailable).toBeFalse();
    // An owner configuration update after the daemon started must survive the probe.
    saveConfig({ ...config, experimentalFreshConversationPerTurn: true });
    expect((await request({proSelectable:true})).status).toBe(200);
    expect(config.proAvailable).toBeTrue(); expect(config.proSelectable).toBeTrue();
    expect(loadConfig().experimentalFreshConversationPerTurn).toBeTrue();
    expect(loadConfig().controlToken).toBe(config.controlToken);
  } finally {
    await server.stop(true);
    if (prior === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = prior;
    rmSync(root,{recursive:true,force:true});
  }
});
