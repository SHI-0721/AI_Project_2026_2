// Opt-in, real Azure usage (~20 seconds of synthetic audio). No API keys are read or printed.
// node tests/live-meeting.mjs http://127.0.0.1:5173 --live
// This proves cloud integration, NOT browser sharing or an actual meeting microphone.
import assert from 'node:assert/strict';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

const origin = process.argv[2];
if (!process.argv.includes('--live') || !['http://127.0.0.1:5173', 'https://talkbridge-cn-ja-20261024.artfulzebra9.chatgpt.site'].includes(origin)) {
  throw new Error('Specify the local or existing production origin and --live to authorize the bounded service check.');
}
sdk.Diagnostics.StopConsoleOutput();
let session, stage = 'config';
async function request(path, body, expected = 200) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET',
    headers: { ...(body ? {'Content-Type':'application/json'} : {}), ...(session ? {Authorization:'Bearer '+session.token} : {}) },
    ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(15000) });
  assert.equal(response.status, expected, 'API_STATUS_'+response.status);
  return response.json();
}
const action = (name, data = {}, status = 200) => request('/api/room', {action:name, ...(session ? {roomId:session.roomId} : {}), ...data}, status);
async function recognize(authorization, language, voice, text) {
  const response = await fetch(`https://${authorization.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method:'POST', headers:{Authorization:'Bearer '+authorization.token, 'Content-Type':'application/ssml+xml',
      'X-Microsoft-OutputFormat':'riff-16khz-16bit-mono-pcm','User-Agent':'Kotoba-Meeting-ServiceCheck'},
    body:`<speak version="1.0" xml:lang="${language}"><voice name="${voice}">${text}</voice></speak>`, signal:AbortSignal.timeout(15000) });
  assert.ok(response.ok, 'TTS_STATUS_'+response.status);
  const config = sdk.SpeechConfig.fromEndpoint(new URL(`wss://${authorization.region}.stt.speech.microsoft.com/speech/universal/v2`));
  config.authorizationToken = authorization.token;
  config.speechRecognitionLanguage = language;
  const audio = sdk.AudioConfig.fromWavFileInput(Buffer.from(await response.arrayBuffer()));
  const recognizer = new sdk.SpeechRecognizer(config, audio);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('RECOGNITION_TIMEOUT')), 25000);
      recognizer.recognizeOnceAsync(result => {
        if (result.reason === sdk.ResultReason.RecognizedSpeech && result.text.trim()) resolve(result.text);
        else reject(new Error('NO_SPEECH_RESULT'));
      }, () => reject(new Error('RECOGNITION_FAILED')));
    });
  } finally {
    clearTimeout(timer);
    await new Promise(resolve => {
      const deadline = setTimeout(resolve, 1500);
      const done = () => { clearTimeout(deadline); resolve(); };
      try { recognizer.close(done, done); } catch { done(); }
    });
    audio.close(); config.close();
  }
}
try {
  assert.equal((await request('/api/config')).speechReady, true);
  stage = 'create';
  const created = await action('create', {deviceMode:'solo', language:'en', otherLanguage:'zh', mode:'live'}, 201);
  session = created.session;
  let room = (await action('start')).room;
  stage = 'token';
  const authorization = await request('/api/speech-token', {roomId:session.roomId});
  for (const example of [
    {lang:'en', locale:'en-US', voice:'en-US-JennyNeural', side:'a', target:'zh', text:'Today we will learn about neural networks. Please open your textbook to page ten.'},
    {lang:'zh', locale:'zh-CN', voice:'zh-CN-XiaoxiaoNeural', side:'b', target:'en', text:'老师，请再解释一下这个问题，谢谢。'},
  ]) {
    stage = 'recognize-'+example.lang;
    const original = await recognize(authorization, example.locale, example.voice, example.text);
    assert.match(original, example.lang === 'en' ? /neural|network|textbook/i : /老师|解释|问题/);
    const id = crypto.randomUUID();
    const base = {id, sourceLanguage:example.lang, speakerSide:example.side, generation:room.generation};
    stage = 'translate-'+example.lang;
    await action('caption', {...base, text:original.slice(0, Math.max(2, original.length-3)), revision:1, isFinal:false});
    const result = await action('caption', {...base, text:original, revision:2, isFinal:true});
    const caption = result.room.captions.find(c => c.id === id);
    assert.equal(result.room.captions.filter(c => c.id === id).length, 1);
    assert.equal(caption.targetLanguage, example.target);
    assert.equal(caption.translationState, 'done');
    assert.match(caption.translation, example.target === 'zh' ? /[\u4e00-\u9fff]/ : /[a-z]{3}/i);
    console.log(JSON.stringify({stage, original, translation:caption.translation, singleFinalRow:true}));
    await action('pause');
    room = (await action('start')).room;
  }
  console.log(JSON.stringify({ok:true, proof:'synthetic English and Chinese audio -> Azure STT -> Kotoba caption API -> Azure translation; not real meeting acceptance'}));
} catch {
  console.log(JSON.stringify({ok:false,stage})); process.exitCode = 1;
} finally {
  if (session) try { await action('end'); console.log(JSON.stringify({testRoomEnded:true})); }
  catch { console.log(JSON.stringify({testRoomEnded:false})); process.exitCode = 1; }
}
