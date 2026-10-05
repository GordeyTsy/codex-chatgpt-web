const test = require('node:test');
const assert = require('node:assert/strict');
const { CapabilityMonitor } = require('../electron/capability-monitor.cjs');
function fixture() {
  const calls = [], timers = [];
  const host = { activeTraceId: null, currentOperation: () => null,
    inspectSession: async () => { calls.push('inspect'); return { proSelectable: true }; } };
  const supervisor = { readConfig: () => ({ host: '127.0.0.1', port: 1234, controlToken: 'synthetic', browserInteractionMode: 'automatic' }),
    proxyHealthPayload: async () => ({ active_http_turns: 0, active_browser_turns: 0 }) };
  const monitor = new CapabilityMonitor({ host, supervisor, logger: {info(){},warn(){}},
    schedule: (_f, ms) => { timers.push(ms); return 1; }, cancel(){},
    fetchImpl: async (_url, req) => { calls.push(JSON.parse(req.body)); return {ok: true, status: 200}; } });
  monitor.stopped = false; return { monitor, host, supervisor, calls, timers };
}
test('hourly positive picker evidence updates hot catalog without restarting', async () => {
  const f = fixture(); await f.monitor.check(); assert.deepEqual(f.calls, ['inspect',{proSelectable:true}]);
  assert.equal(f.timers.at(-1),3600000);
});
test('active turn defers inspection and preserves catalog', async () => {
  const f = fixture(); f.host.activeTraceId='active'; await f.monitor.check();
  assert.deepEqual(f.calls,[]); assert.equal(f.timers.at(-1),60000);
});
test('unrelated native HTTP generation does not starve idle browser discovery', async () => {
  const f = fixture(); f.supervisor.proxyHealthPayload = async () => ({ active_http_turns: 2, active_browser_turns: 0 });
  await f.monitor.check(); assert.deepEqual(f.calls, ['inspect',{proSelectable:true}]);
  assert.equal(f.timers.at(-1),3600000);
});
test('browser activity reported by the bridge defers a racing inspection', async () => {
  const f = fixture(); f.supervisor.proxyHealthPayload = async () => ({ active_http_turns: 1, active_browser_turns: 1 });
  await f.monitor.check(); assert.deepEqual(f.calls, []); assert.equal(f.timers.at(-1),60000);
});
test('negative picker observation never removes a model', async () => {
  const f = fixture(); f.host.inspectSession=async()=>({proSelectable:false}); await f.monitor.check();
  assert.deepEqual(f.calls,[]); assert.equal(f.timers.at(-1),3600000);
});
test('failed probe preserves catalog and retries without model generation', async () => {
  const f = fixture(); f.host.inspectSession=async()=>{throw Error('network');}; await f.monitor.check();
  assert.deepEqual(f.calls,[]); assert.equal(f.timers.at(-1),60000);
});
test('quit fences an outstanding inspection and prevents reschedule', async () => {
  const f=fixture(); f.host.inspectSession=async()=>{f.monitor.stop();return {proSelectable:true};};
  await f.monitor.check(); assert.deepEqual(f.calls,[]); assert.deepEqual(f.timers,[]);
});
test('in-flight guard prevents duplicate inspections', async () => {
  const f=fixture(); let done; f.host.inspectSession=()=>new Promise(r=>{done=r;});
  const first=f.monitor.check(); await new Promise(r=>setImmediate(r)); await f.monitor.check();
  done({proSelectable:true}); await first; assert.equal(f.calls.length,1);
});
