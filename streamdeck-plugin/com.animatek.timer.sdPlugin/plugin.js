let serverWS = null;
function connectServer(){ if (serverWS && serverWS.readyState === WebSocket.OPEN) return; try{ serverWS = new WebSocket('ws://127.0.0.1:8765'); }catch(e){} }
function sendCommand(action, payload){ connectServer(); try{ serverWS.send(JSON.stringify({ type: 'command', action, payload })); }catch(e){} }

function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo) {
  const sdWS = new WebSocket('ws://127.0.0.1:' + inPort);
  sdWS.onopen = function() { sdWS.send(JSON.stringify({ event: inRegisterEvent, uuid: inUUID })); };
  sdWS.onmessage = function(evt) {
    const msg = JSON.parse(evt.data);
    const event = msg['event']; const action = msg['action'];
    if (event === 'keyDown') {
      switch(action){
        case 'com.animatek.timer.start': sendCommand('start'); break;
        case 'com.animatek.timer.pause': sendCommand('pause'); break;
        case 'com.animatek.timer.resume': sendCommand('resume'); break;
        case 'com.animatek.timer.reset': sendCommand('reset'); break;
        case 'com.animatek.timer.add1': sendCommand('add', 60); break;
        case 'com.animatek.timer.add5': sendCommand('add', 300); break;
        case 'com.animatek.timer.add10': sendCommand('add', 600); break;
        case 'com.animatek.timer.finish': sendCommand('finish'); break;
        case 'com.animatek.timer.category':
          const cat = (msg?.payload?.settings?.category) || null;
          if (cat) sendCommand('setCategory', cat);
          break;
      }
    }
  };
}
