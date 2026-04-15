import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const base = './dist/tools/';
const mods = [
  ['calendar','Calendar'],['chores','Chore'],['lists','List'],['tasks','Task'],
  ['family','Family'],['misc','Misc'],['rewards','Reward'],['meals','Meal'],['photos','Photo']
];
const plusKeys = new Set(['rewards','meals','photos']);

async function run(includePlus) {
  const server = new McpServer({ name:'skylight-probe', version:'0' });
  for (const [key, name] of mods) {
    if (!includePlus && plusKeys.has(key)) continue;
    const mod = await import(base + key + '.js');
    const fn = mod[`register${name}Tools`];
    if (typeof fn !== 'function') throw new Error(`missing register${name}Tools in ${key}.js`);
    fn(server);
  }
  const [a,b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name:'probe', version:'0' }, { capabilities:{} });
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = await client.listTools();
  console.log(`\n=== plus=${includePlus}: ${res.tools.length} tools ===`);
  for (const t of res.tools) console.log(' ', t.name);
  // Validate every tool has a non-empty inputSchema
  const bad = res.tools.filter(t => !t.inputSchema || typeof t.inputSchema !== 'object');
  if (bad.length) console.log('MISSING SCHEMAS:', bad.map(t=>t.name));
  else console.log('  [all tools have inputSchema]');
  await client.close();
}

await run(false);
await run(true);
