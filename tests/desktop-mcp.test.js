import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestApp } from './helpers.js';

const binary = process.env.LUMINA_TEST_DESKTOP_BINARY || path.resolve('node_modules/electron/dist/electron');
const packaged = Boolean(process.env.LUMINA_TEST_DESKTOP_BINARY);
const available = existsSync(binary) && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);

test('desktop binary provides stdio MCP without a checkout or second backend, and exits on client close', {skip:!available,timeout:30000}, async () => {
  const t = await startTestApp();
  const client = new Client({name:'packaged-mcp-regression',version:'1'});
  const transport = new StdioClientTransport({command:binary,args:packaged?['--mcp']:['.','--mcp'],
    env:{...process.env,LUMINA_DATA_DIR:t.dataRoot,LUMINA_NO_AUTOLAUNCH:'1'},stderr:'pipe'});
  let errors='';
  transport.stderr?.on('data',(chunk)=>{errors=(errors+chunk).slice(-4000);});
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool)=>tool.name==='openrouter_credit_status'));
    assert.ok(tools.tools.some((tool)=>tool.name==='inspect_video'));
    const originalPid=JSON.parse(await readFile(path.join(t.dataRoot,'data','endpoint.json'),'utf8')).pid;
    const projects=parse(await client.callTool({name:'list_projects',arguments:{}}));
    assert.ok(Array.isArray(projects));
    const credits=parse(await client.callTool({name:'openrouter_credit_status',arguments:{refresh:true}}));
    assert.equal(credits.status,'missing_key');
    const endpoint=JSON.parse(await readFile(path.join(t.dataRoot,'data','endpoint.json'),'utf8'));
    assert.equal(endpoint.pid,originalPid,'helper must not replace endpoint/backend');
  } catch(error) { throw new Error(`${error.message}\n${errors}`); }
  finally { await client.close(); await t.close(); }
});


test('fresh packaged desktop starts with strict $12 protection and serves bundled MCP', {skip:!available || !packaged,timeout:30000}, async () => {
  const root=await mkdtemp(path.join(tmpdir(),'lumina-package-defaults-'));
  const child=spawn(binary,[`--user-data-dir=${path.join(root,'profile')}`],{env:{...process.env,LUMINA_DATA_DIR:root,
    LUMINA_MOCK:'1',LUMINA_OFFLINE:'1',LUMINA_SMOKE_SCREENSHOT:path.join(root,'window.png')},stdio:'ignore'});
  const exited=new Promise((resolve)=>child.once('exit',(code)=>resolve(code)));
  const client=new Client({name:'fresh-package-test',version:'1'});
  let connected=false;
  try {
    let endpoint;
    for(let i=0;i<100;i++) {
      try { endpoint=JSON.parse(await readFile(path.join(root,'data','endpoint.json'),'utf8')); break; }
      catch { await new Promise((resolve)=>setTimeout(resolve,100)); }
    }
    assert.ok(endpoint,'packaged backend must start');
    await client.connect(new StdioClientTransport({command:binary,args:['--mcp'],env:{...process.env,
      LUMINA_DATA_DIR:root,LUMINA_NO_AUTOLAUNCH:'1'},stderr:'ignore'}));
    connected=true;
    const budget=parse(await client.callTool({name:'budget_status',arguments:{}}));
    assert.equal(budget.settings.enabled,true);
    assert.equal(budget.settings.strictPrices,true);
    assert.equal(budget.settings.totalUsd,12);
    assert.equal(budget.requests,0);
    assert.equal(await exited,0);
    assert.ok((await readFile(path.join(root,'window.png'))).length>1000);
  } finally {
    if(connected) await client.close();
    if(child.exitCode===null) child.kill('SIGTERM');
    await exited;
    await rm(root,{recursive:true,force:true});
  }
});
