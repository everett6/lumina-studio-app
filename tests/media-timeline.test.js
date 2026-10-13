import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stitchClips, probe, run } from '../src/video.js';
const ffmpeg = spawnSync('ffmpeg', ['-version'], {stdio:'ignore'}).status === 0;

test('mixed provider shapes/rates normalize to an exact timeline with cut boundaries and sound intact', {skip:!ffmpeg,timeout:60000}, async () => {
  const root = await mkdtemp(path.join(tmpdir(),'lumina-mixed-timeline-'));
  try {
    const cloud=path.join(root,'cloud.mp4'), wan=path.join(root,'wan.mp4'), output=path.join(root,'film.mp4');
    // Synthetic cloud/Wan shapes; no network, keys or billed provider calls.
    await run('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=160x90:r=24:d=0.8',
      '-f','lavfi','-i','sine=frequency=440:duration=0.8','-c:v','libx264','-c:a','aac','-pix_fmt','yuv420p','-y',cloud],10000);
    await run('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:s=192x108:r=12:d=0.8','-c:v','libx264','-pix_fmt','yuv420p','-y',wan],10000);
    for (const rate of [24,25,30,50,60]) {
    const joined=await stitchClips([{file:cloud,duration:15/rate},{file:wan,duration:12/rate}],{fps:rate,size:{width:320,height:180},transition:'cut',deliver:false});
    await writeFile(output,joined.bytes);
    const info=await probe(output);
    assert.deepEqual([info.width,info.height,info.fps,info.frames],[320,180,rate,27]);
    assert.equal(info.hasAudio,true); assert.ok(Math.abs(info.duration-27/rate)<1/rate);
    const frames=spawnSync('ffmpeg',['-v','error','-i',output,'-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:10000});
    assert.equal(frames.status,0,frames.stderr.toString());
    const before=frames.stdout.subarray(14*3,15*3),after=frames.stdout.subarray(15*3,16*3);
    assert.ok(before[0]>200 && before[2]<25,`red outgoing frame ${before}`);
    assert.ok(after[2]>200 && after[0]<25,`blue incoming frame ${after}`);
    const packets=JSON.parse(await run('ffprobe',['-v','error','-show_packets','-show_entries','packet=stream_index,dts_time','-of','json',output],10000));
    const previous=new Map();
    for (const p of packets.packets) {
      const value=Number(p.dts_time); assert.ok(Number.isFinite(value));
      if(previous.has(p.stream_index)) assert.ok(value>previous.get(p.stream_index));
      previous.set(p.stream_index,value);
    }
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});
