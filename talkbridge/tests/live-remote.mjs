// Opt-in real Azure check: <30 seconds of synthetic audio, two simultaneous streams, no retries.
// node tests/live-remote.mjs http://127.0.0.1:5173 --live
// Uses only short-lived site tokens, never .dev.vars or long-lived service keys.
// This is provider/API integration evidence, not two-device microphone or meeting acceptance.
import assert from 'node:assert/strict';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

const origin=process.argv[2];
if(!process.argv.includes('--live')||!['http://127.0.0.1:5173','http://127.0.0.1:4173','http://127.0.0.1:3000','https://talkbridge-cn-ja-20261024.artfulzebra9.chatgpt.site'].includes(origin))throw new Error('Specify the approved local or existing production origin and --live.');
sdk.Diagnostics.StopConsoleOutput();
const sessions={},lanes=[],report=value=>console.log(JSON.stringify(value));
const fatal=Promise.withResolvers();let failure,stage='config',room,heartbeat,deadline;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fail(value){if(!failure){failure=value;fatal.resolve(value);}}
async function checked(promise){const value=await Promise.race([promise.then(result=>({result})),fatal.promise.then(error=>({error}))]);if(value.error)throw new Error('SERVICE_CHECK_FAILED');return value.result;}
async function request(path,body,role='host',expected=200){
  const session=sessions[role];
  const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(session?{Authorization:'Bearer '+session.token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  if(response.status!==expected){fail({stage,code:'API_STATUS',status:response.status,role});throw new Error('API_STATUS');}
  return response.json();
}
const action=(name,data={},role='host',status=200)=>request('/api/room',{action:name,...(sessions[role]?{roomId:sessions[role].roomId}:{}),...data},role,status);
const currentCapture=role=>({generation:room.generation,captureGeneration:room[role+'CaptureGeneration']});
const read=role=>request('/api/room?roomId='+encodeURIComponent(sessions[role].roomId),undefined,role);
function pcm(wav){
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');let format,data;
  for(let pos=12;pos+8<=wav.length;){const length=wav.readUInt32LE(pos+4),start=pos+8;assert.ok(start+length<=wav.length);const id=wav.toString('ascii',pos,pos+4);if(id==='fmt ')format=wav.subarray(start,start+length);if(id==='data')data=wav.subarray(start,start+length);pos=start+length+length%2;}
  assert.ok(format&&data);assert.deepEqual([format.readUInt16LE(0),format.readUInt16LE(2),format.readUInt32LE(4),format.readUInt16LE(14)],[1,1,16000,16]);return data;
}
async function synthesize(auth,example){
  const response=await fetch(`https://${auth.region}.tts.speech.microsoft.com/cognitiveservices/v1`,{method:'POST',headers:{Authorization:'Bearer '+auth.token,'Content-Type':'application/ssml+xml','X-Microsoft-OutputFormat':'riff-16khz-16bit-mono-pcm','User-Agent':'Kotoba-Remote-ServiceCheck'},body:`<speak version="1.0" xml:lang="${example.locale}"><voice name="${example.voice}">${example.text}</voice></speak>`,signal:AbortSignal.timeout(15000)});
  if(!response.ok){fail({stage:'tts',code:'TTS_STATUS',status:response.status,role:example.role});throw new Error('TTS_STATUS');}
  return pcm(Buffer.from(await response.arrayBuffer()));
}
function makeLane(auth,example){
  const config=sdk.SpeechConfig.fromEndpoint(new URL(`wss://${auth.region}.stt.speech.microsoft.com/speech/universal/v2`));config.authorizationToken=auth.token;config.speechRecognitionLanguage=example.locale;
  const stream=sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000,16,1)),audio=sdk.AudioConfig.fromStreamInput(stream),recognizer=new sdk.SpeechRecognizer(config,audio);
  const started=Promise.withResolvers(),lane={...example,config,stream,audio,recognizer,started,active:false,closed:false,startedAt:null,results:[],waiters:new Map(),capture:currentCapture(example.role)};lanes.push(lane);
  recognizer.sessionStarted=()=>{if(lane.closed)return;if(lane.startedAt!==null){fail({stage:'recognition',role:lane.role,code:'UNEXPECTED_RECONNECT'});return;}lane.active=true;lane.startedAt=performance.now();started.resolve();};
  recognizer.sessionStopped=()=>{lane.active=false;if(!lane.closed)fail({stage:'recognition',role:lane.role,code:'UNEXPECTED_SESSION_STOP'});};
  recognizer.recognized=(_,event)=>{
    if(lane.closed||event.result.reason!==sdk.ResultReason.RecognizedSpeech||!event.result.text.trim())return;
    lane.results.push({text:event.result.text,at:performance.now(),bothActive:lanes.length===2&&lanes.every(value=>value.active)});
    lane.waiters.get(lane.results.length)?.resolve();
  };
  recognizer.canceled=(_,event)=>{lane.active=false;if(lane.closed||event.reason===sdk.CancellationReason.EndOfStream)return;fail({stage:'recognition',role:lane.role,code:sdk.CancellationErrorCode[event.errorCode]??'UNKNOWN',httpStatus:event.errorDetails?.match(/\b(401|403|429)\b/)?.[1]??null});};
  return lane;
}
async function closeLane(lane){
  if(lane.closed)return;lane.closed=true;lane.active=false;
  try{lane.stream.close();}catch{}
  for(const method of ['stopContinuousRecognitionAsync','close'])await new Promise(resolve=>{const timer=setTimeout(resolve,1500),done=()=>{clearTimeout(timer);resolve();};try{lane.recognizer[method](done,done);}catch{done();}});
  try{lane.audio.close();lane.config.close();}catch{}
}
async function feed(entries){
  const length=Math.max(...entries.map(entry=>entry.audio.length));
  for(let offset=0;offset<length;offset+=3200){
    if(failure)throw new Error('SERVICE_CHECK_FAILED');
    for(const entry of entries){const chunk=Buffer.alloc(Math.min(3200,length-offset));if(offset<entry.audio.length)entry.audio.copy(chunk,0,offset,Math.min(offset+chunk.length,entry.audio.length));entry.lane.stream.write(chunk.buffer.slice(chunk.byteOffset,chunk.byteOffset+chunk.byteLength));}
    await checked(sleep(100));
  }
}
async function waitFinal(lane,count){if(lane.results.length>=count)return;const waiting=Promise.withResolvers();lane.waiters.set(count,waiting);await checked(waiting.promise);}
async function saveResult(lane,result){
  assert.match(result.text,lane.role==='host'?/神经|学习/:/neural|network/i);
  const id=`${lane.role==='host'?'h':'g'}-${lane.capture.captureGeneration}-${crypto.randomUUID()}`;
  const base={id,sourceLanguage:lane.language,...lane.capture};
  await checked(action('caption',{...base,text:result.text.slice(0,-2),revision:1,isFinal:false},lane.role));
  const response=await checked(action('caption',{...base,text:result.text,revision:2,isFinal:true},lane.role));
  const caption=response.room.captions.find(value=>value.id===id);
  assert.ok(caption?.isFinal);assert.equal(caption.translationState,'done');assert.equal(caption.targetLanguage,lane.target);
  assert.equal(caption.speakerSide,lane.role==='host'?'a':'b');assert.equal(caption.speakerId,lane.role);
  assert.match(caption.translation,lane.target==='zh'?/[\u4e00-\u9fff]/:/[a-z]{3}/i);
  report({stage:'translated',role:lane.role,original:caption.text,translation:caption.translation});return id;
}

try{
  assert.equal((await request('/api/config')).speechReady,true);
  stage='create';const created=await action('create',{deviceMode:'remote',mode:'live',language:'zh'},'host',201);sessions.host=created.session;room=created.room;
  stage='join';const joined=await action('join',{code:room.code,language:'en'},'guest');sessions.guest=joined.session;room=joined.room;
  stage='start-host';room=(await action('start',currentCapture('host'),'host')).room;
  stage='start-guest';room=(await action('start',currentCapture('guest'),'guest')).room;
  assert.equal(room.hostListening,true);assert.equal(room.guestListening,true);
  heartbeat=setInterval(()=>{void Promise.all([read('host'),read('guest')]).catch(()=>fail({stage:'heartbeat',code:'API_FAILED'}));},4000);
  stage='tokens';const authorizations=await Promise.all(['host','guest'].map(role=>request('/api/speech-token',{roomId:sessions[role].roomId,...currentCapture(role)},role)));
  assert.equal(authorizations[0].region,authorizations[1].region);
  const examples=[{role:'host',language:'zh',target:'en',locale:'zh-CN',voice:'zh-CN-XiaoxiaoNeural',text:'你好，今天学习神经网络。'},{role:'guest',language:'en',target:'zh',locale:'en-US',voice:'en-US-JennyNeural',text:'Today we study neural networks.'}];
  stage='tts';const samples=await Promise.all(examples.map((example,index)=>synthesize(authorizations[index],example)));
  const tail=Buffer.alloc(32000*2),leading=Buffer.alloc(8000),first=samples.map(sample=>Buffer.concat([sample,tail]));
  const totalAudioSeconds=(leading.length*2+Math.max(...first.map(sample=>sample.length))*2+samples[1].length+tail.length)/32000;
  assert.ok(totalAudioSeconds<30);report({stage:'input',totalAudioSeconds,connections:2,synthetic:true});
  deadline=setTimeout(()=>fail({stage:'recognition',code:'DEADLINE'}),55000);
  examples.forEach((example,index)=>makeLane(authorizations[index],example));
  stage='concurrent-recognition';
  const begins=lanes.map(lane=>new Promise(resolve=>lane.recognizer.startContinuousRecognitionAsync(resolve,()=>{fail({stage:'recognition',role:lane.role,code:'START_FAILED'});resolve();})));
  for(const lane of lanes)lane.stream.write(leading.buffer.slice(leading.byteOffset,leading.byteOffset+leading.byteLength));
  await checked(Promise.all(begins));await checked(Promise.all(lanes.map(lane=>lane.started.promise)));
  await feed(lanes.map((lane,index)=>({lane,audio:first[index]})));await checked(Promise.all(lanes.map(lane=>waitFinal(lane,1))));
  const overlapMs=Math.round(Math.min(...lanes.map(lane=>lane.results[0].at))-Math.max(...lanes.map(lane=>lane.startedAt)));
  assert.ok(overlapMs>1000&&lanes.every(lane=>lane.results[0].bothActive));
  stage='both-captions';const ids=await Promise.all(lanes.map(lane=>saveResult(lane,lane.results[0])));
  for(const role of ['host','guest']){const view=(await checked(read(role))).room;for(const id of ids){const matches=view.captions.filter(caption=>caption.id===id);assert.equal(matches.length,1);assert.equal(matches[0].translationState,'done');}}
  stage='pause-host';await closeLane(lanes[0]);room=(await checked(action('pause',lanes[0].capture,'host'))).room;
  assert.equal(room.hostListening,false);assert.equal(room.guestListening,true);assert.equal(room.state,'running');assert.equal(room.guestCaptureGeneration,lanes[1].capture.captureGeneration);
  stage='guest-continues';const previous=lanes[1].results.length;
  await feed([{lane:lanes[1],audio:Buffer.concat([samples[1],tail])}]);await waitFinal(lanes[1],previous+1);
  const continuingId=await saveResult(lanes[1],lanes[1].results[previous]);
  const hostView=(await checked(read('host'))).room;assert.ok(hostView.captions.some(caption=>caption.id===continuingId&&caption.translationState==='done'));assert.equal(hostView.hostListening,false);assert.equal(hostView.guestListening,true);
  report({ok:true,overlapMs,bothFinalReceivedWhileBothSessionsActive:true,bothParticipantsSeeBothTranslations:true,guestContinuesAfterHostPause:true,totalAudioSeconds,proof:'Two overlapping synthetic STT streams -> both role-authorized caption APIs -> translated shared history; not real two-device microphone acceptance'});
}catch{report({ok:false,stage,...(failure?{failure}:{code:'CHECK_FAILED'})});process.exitCode=1;}
finally{
  clearInterval(heartbeat);clearTimeout(deadline);await Promise.all(lanes.map(closeLane));
  if(sessions.host)try{const ended=await action('end');assert.equal(ended.room.state,'ended');assert.equal(ended.room.captions.length,0);report({testRoomEnded:true});}catch{report({testRoomEnded:false});process.exitCode=1;}
}
