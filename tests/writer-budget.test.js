import assert from 'node:assert/strict';
import test from 'node:test';
import {createDirectors} from '../src/directors/index.js';
import {startTestApp} from './helpers.js';

test('strict budget blocks every paid writer entry before any network request', async () => {
  let calls=0;
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{calls++;throw Error('must not spend');};
  try {
    const directors=createDirectors({budget:{settings:()=>({enabled:true,strictPrices:true})},enableMock:true});
    for(const id of ['openrouter','openai','anthropic','nemotron']) {
      const d=directors.get(id);
      await assert.rejects(d.complete({key:'test',model:d.models[0],prompt:'test'}),{category:'budget_limit',status:402});
      await assert.rejects(d.refine({key:'test',model:d.models[0],idea:'test'}),{category:'budget_limit'});
    }
    assert.equal(calls,0);
    assert.ok(await directors.get('mock').refine({model:'mock-director',idea:'a boat'}));
  } finally {globalThis.fetch=original;}
});

test('book writer requests return a budget refusal without provider traffic or ledger changes', async () => {
  const t=await startTestApp({budgetSettings:{}});
  try {
    t.app.keys.set('openrouter','fake-test-key');
    const project=(await t.call('POST','/api/projects',{name:'unpriced writing'})).body.project;
    const book=(await t.call('POST',`/api/projects/${project.id}/books`,{title:'Test',kind:'novel',writer:`openrouter:${createDirectors().get('openrouter').models[0]}`})).body.book;
    assert.equal((await t.call('POST',`/api/books/${book.id}/bible`,{})).status,428,'the app asks before a paid writer');
    const result=await t.call('POST',`/api/books/${book.id}/bible`,{},{headers:{'x-lumina-confirm-spend':'1'}});
    assert.equal(result.status,402,JSON.stringify(result.body));
    assert.match(result.body.error,/unpriced writer/);
    assert.equal((await t.call('GET','/api/budget')).body.spentUsd,0);
  } finally {await t.close();}
});

test('storyboard planning with a paid writer is refused as a budget limit (402), not a writer failure', async () => {
  const t=await startTestApp({budgetSettings:{}});
  try {
    t.app.keys.set('openrouter','fake-test-key');
    const project=(await t.call('POST','/api/projects',{name:'unpriced planning'})).body.project;
    const id=(await t.call('POST',`/api/projects/${project.id}/storyboards`,{title:'T',idea:'A trickster',writer:`openrouter:${createDirectors().get('openrouter').models[0]}`})).body.sequence.id;
    const result=await t.call('POST',`/api/storyboards/${id}/plan`,{});
    assert.equal(result.status,402,JSON.stringify(result.body));
    assert.match(result.body.error,/budget/i);
  } finally {await t.close();}
});
