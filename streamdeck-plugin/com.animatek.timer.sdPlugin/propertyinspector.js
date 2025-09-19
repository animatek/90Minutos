let websocket=null, uuid=null, action=null;
function getCategories(){return fetch('http://127.0.0.1:5173/api/config').then(r=>r.json()).then(cfg=>cfg.categories||[]).catch(_=>[]);}
async function populate(){ const sel=document.getElementById('category'); sel.innerHTML=''; const cats=await getCategories(); for(const c of cats){ const opt=document.createElement('option'); opt.value=c; opt.textContent=c; sel.appendChild(opt);} }
document.getElementById('refresh').onclick = populate;
function connectElgatoStreamDeckSocket (inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
  action = JSON.parse(inActionInfo).action; uuid = inUUID;
  websocket = new WebSocket('ws://127.0.0.1:' + inPort);
  websocket.onopen = function () { websocket.send(JSON.stringify({ event: inRegisterEvent, uuid: inUUID })); populate(); };
}
document.getElementById('category').addEventListener('change', function(){
  if (!websocket || !uuid) return;
  const payload = { settings: { category: this.value } };
  websocket.send(JSON.stringify({ event: 'setSettings', context: uuid, payload }));
});
